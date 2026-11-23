from __future__ import annotations

import json
import re
import shutil
import subprocess
from importlib.resources import files
from typing import Any

import pytest

from docmost_mcp_remote.apps import (
    FORBIDDEN,
    MAX_VIEW_BYTES,
    VIEW_NAMES,
    build_view,
    lint_view,
    view_uri,
)
from docmost_mcp_remote.sections import unified_diff

ASSETS = files("docmost_mcp_remote.apps")


@pytest.mark.parametrize("name", VIEW_NAMES)
def test_view_is_clean_and_complete(name: str) -> None:
    html = build_view(name)
    assert lint_view(html) == []
    assert len(html.encode()) < MAX_VIEW_BYTES
    assert "window.mcpBridge" in html
    assert "window.dom" in html
    assert ASSETS.joinpath("base.css").read_text(encoding="utf-8") in html
    assert "/*__" not in html
    assert html.startswith("<!doctype html>")
    assert '<meta name="color-scheme" content="light dark">' in html
    assert html.count("<script>") == 1
    assert html.count("<style>") == 1
    assert '<main id="app"' in html


@pytest.mark.parametrize("name", VIEW_NAMES)
def test_view_uri_is_content_addressed(name: str) -> None:
    uri = view_uri(name)
    assert re.fullmatch(rf"ui://docmost/{name}-[0-9a-f]{{8}}\.html", uri)
    assert view_uri(name) == uri
    assert build_view(name) == build_view(name)


def test_view_uris_differ() -> None:
    assert len({view_uri(name) for name in VIEW_NAMES}) == len(VIEW_NAMES)


def test_unknown_view() -> None:
    with pytest.raises(KeyError):
        build_view("nope")
    with pytest.raises(KeyError):
        view_uri("nope")


@pytest.mark.parametrize("needle", FORBIDDEN)
def test_lint_flags_each_needle(needle: str) -> None:
    assert lint_view(f"<p>before {needle} after</p>") == [needle]


def test_bridge_lists_only_known_modes() -> None:
    bridge = ASSETS.joinpath("bridge.js").read_text(encoding="utf-8")
    assert 'const MODES = ["inline", "fullscreen"];' in bridge
    assert '"2026-01-26"' in bridge
    assert "pip" not in bridge


node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

_RUNNER = """
const vm = require("vm");
const fs = require("fs");
globalThis.window = {};
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
for (const [key, [fn, arg]] of Object.entries(input)) out[key] = window.dom[fn](arg);
process.stdout.write(JSON.stringify(out));
"""


def run_dom(calls: dict[str, tuple[str, Any]]) -> dict[str, Any]:
    path = str(ASSETS.joinpath("dom.js"))
    executable = shutil.which("node")
    assert executable is not None
    done = subprocess.run(  # noqa: S603
        [executable, "-e", _RUNNER, path],
        input=json.dumps(calls),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    result: dict[str, Any] = json.loads(done.stdout)
    return result


@node
def test_safe_href() -> None:
    cases = {
        "https": "https://a.b/",
        "http": "http://a.b/x?y=1",
        "js": "javascript:alert(1)",
        "js_upper": " JavaScript:alert(1)",
        "data": "data:x",
        "relative": "//x",
        "vbscript": "vbscript:msgbox(1)",
        "empty": "",
        "path": "/page/1",
    }
    out = run_dom({key: ("safeHref", value) for key, value in cases.items()})
    assert out["https"] == "https://a.b/"
    assert out["http"] == "http://a.b/x?y=1"
    for key in ("js", "js_upper", "data", "relative", "vbscript", "empty", "path"):
        assert out[key] is None, key


@node
def test_unwrap() -> None:
    from docmost_mcp_remote.tools.untrusted import wrap

    text = "line one\nsays </docmost-untrusted-content> here\n"
    out = run_dom(
        {
            "wrapped": ("unwrap", wrap(text, source="page 0192")),
            "plain": ("unwrap", "just text"),
            "partial": ("unwrap", '<docmost-untrusted-content source="x">\nno end'),
        }
    )
    assert out["wrapped"] == text
    assert out["plain"] == "just text"
    assert out["partial"] == '<docmost-untrusted-content source="x">\nno end'


@node
def test_parse_unified_diff() -> None:
    diff, cut = unified_diff("a\nb\nc\n", "a\nB\nc\nd\n", limit=10_000)
    assert not cut
    short, was_cut = unified_diff("a\nb\nc\n", "a\nB\nc\nd\n", limit=len(diff) - 3)
    assert was_cut
    out = run_dom({"full": ("parseUnifiedDiff", diff), "cut": ("parseUnifiedDiff", short)})

    [hunk] = out["full"]
    assert hunk["header"].startswith("@@ ")
    assert (hunk["oldStart"], hunk["oldLines"]) == (1, 3)
    assert (hunk["newStart"], hunk["newLines"]) == (1, 4)
    assert [(line["kind"], line["text"]) for line in hunk["lines"]] == [
        ("context", "a"),
        ("del", "b"),
        ("add", "B"),
        ("context", "c"),
        ("add", "d"),
    ]

    [cut_hunk] = out["cut"]
    kinds = [line["kind"] for line in cut_hunk["lines"]]
    assert kinds == ["context", "del", "add", "context"][: len(kinds)]
    assert len(kinds) >= 3


_EL_RUNNER = """
const vm = require("vm");
const fs = require("fs");
globalThis.window = {};
globalThis.document = {
  createElement: (tag) => ({
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); },
  }),
  createTextNode: (value) => ({ text: value }),
};
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const out = {};
for (const tag of JSON.parse(fs.readFileSync(0, "utf8"))) {
  try {
    out[tag] = window.dom.el(tag, { class: "x" }).tag;
  } catch (error) {
    out[tag] = "refused";
  }
}
process.stdout.write(JSON.stringify(out));
"""


def run_node(script: str, asset: str, payload: Any) -> Any:
    executable = shutil.which("node")
    assert executable is not None
    done = subprocess.run(  # noqa: S603
        [executable, "-e", script, str(ASSETS.joinpath(asset))],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return json.loads(done.stdout)


@node
def test_el_refuses_active_tags() -> None:
    blocked = ["script", "iframe", "object", "embed", "style", "link", "meta", "SCRIPT", " Iframe"]
    out = run_node(_EL_RUNNER, "dom.js", ["div", "button", *blocked])
    assert out["div"] == "div"
    assert out["button"] == "button"
    for tag in blocked:
        assert out[tag] == "refused", tag


_BRIDGE_RUNNER = """
const vm = require("vm");
const fs = require("fs");
const sent = [];
let handler = null;
const parent = { postMessage: (message) => sent.push(message) };
const other = {};
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty() {} }, scrollWidth: 1, scrollHeight: 1 },
};
globalThis.window = {
  parent,
  addEventListener: (type, fn) => { if (type === "message") handler = fn; },
};
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const bridge = window.mcpBridge;
const contexts = [];
bridge.onHostContext((value) => contexts.push(value.theme));
const reply = (theme) => ({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme } } });
bridge.start({ name: "t", version: "1" }).then(() => {
  const copy = bridge.hostContext();
  copy.theme = "mutated";
  process.stdout.write(JSON.stringify({
    methods: sent.map((m) => m.method),
    contexts,
    theme: bridge.hostContext().theme,
    copyIsFresh: bridge.hostContext() !== bridge.hostContext(),
  }));
});
handler({ source: other, data: reply("from-other-window") });
handler({ source: parent, data: Object.assign(reply("no-jsonrpc"), { jsonrpc: "1.0" }) });
handler({ source: parent, data: "not an object" });
handler({ source: parent, data: reply("dark") });
"""


@node
def test_bridge_checks_source_and_jsonrpc_and_copies_context() -> None:
    out = run_node(_BRIDGE_RUNNER, "bridge.js", None)
    assert out["methods"] == [
        "ui/initialize",
        "ui/notifications/initialized",
        "ui/notifications/size-changed",
    ]
    assert out["contexts"] == ["dark"]
    assert out["theme"] == "dark"
    assert out["copyIsFresh"] is True
