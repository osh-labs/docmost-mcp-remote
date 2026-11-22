from __future__ import annotations

import json
import re
import shutil
import subprocess
from importlib.resources import files
from typing import Any

import pytest

from docmost_mcp_remote.apps import MAX_VIEW_BYTES, build_view, lint_view
from docmost_mcp_remote.sections import unified_diff
from docmost_mcp_remote.tools.untrusted import wrap

ASSETS = files("docmost_mcp_remote.apps")
WRITE_TOOLS = (
    "update_page",
    "replace_section",
    "replace_page_json",
    "restore_page_version",
    "restore_snapshot",
    "trash_page",
    "move_page",
)
PAGE = "0197a3c2-1111-7000-8000-000000000001"
VERSION = "0197a3c2-2222-7000-8000-000000000002"
SECRET = "SECRET-WIKI-TEXT"


def test_review_view_is_clean() -> None:
    html = build_view("review")
    assert lint_view(html) == []
    assert len(html.encode()) < MAX_VIEW_BYTES


def test_review_view_calls_only_read_tools() -> None:
    html = build_view("review")
    calls = re.findall(r"callTool\(\s*([^,)]*)", html)
    names = {call.strip() for call in calls}
    assert names == {'"list_page_history"', '"diff_page"'}
    for tool in WRITE_TOOLS:
        assert not re.search(rf"callTool\(\s*[\"']{tool}[\"']", html)


@pytest.mark.parametrize("label", ["Apply this change", "Discard", "Restore this version"])
def test_review_view_has_button_labels(label: str) -> None:
    assert label in build_view("review")


node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

# A minimal fake DOM and bridge: runs dom.js and review.js, feeds one tool result,
# optionally clicks buttons by label, and reports the rendered text, the button
# labels, the messages sent and the tools called.
_RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
class Text { constructor(v) { this.textContent = String(v); } }
class El {
  constructor(tag) {
    this.tagName = tag; this.childNodes = []; this.attributes = {}; this.listeners = {};
    this.dataset = {}; this.style = { setProperty() {} }; this.hidden = false;
    this.disabled = false;
  }
  appendChild(c) { this.childNodes.push(c); return c; }
  replaceChildren(...c) { this.childNodes = c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = [new Text(v)]; }
}
const app = new El("main");
globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (v) => new Text(v),
  getElementById: () => app,
  documentElement: new El("html"),
};
globalThis.window = globalThis;
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const listeners = {};
const messages = [];
const calls = [];
window.mcpBridge = {
  start: () => Promise.resolve({ displayMode: "inline" }),
  onToolInput: (f) => { listeners.input = f; },
  onToolResult: (f) => { listeners.result = f; },
  onToolCancelled: (f) => { listeners.cancelled = f; },
  onHostContext: () => {},
  hostContext: () => ({ displayMode: "inline" }),
  callTool: (name, args) => {
    calls.push([name, args]);
    const out = (input.tools || {})[name];
    return Promise.resolve({ structuredContent: out, content: [] });
  },
  structured: (r) => r.structuredContent || null,
  sendMessage: (text) => { messages.push(text); return Promise.resolve({}); },
  updateContext: () => Promise.resolve({}),
  openLink: () => Promise.resolve({}),
  requestMode: (m) => Promise.resolve(m),
};
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
vm.runInThisContext(fs.readFileSync(process.argv[2], "utf8"));
function walk(n, f) { f(n); (n.childNodes || []).forEach((c) => walk(c, f)); }
function buttons() {
  const out = [];
  walk(app, (n) => { if (n.tagName === "button" && !n.hidden) out.push(n); });
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
(async () => {
  await tick();
  listeners.result({ structuredContent: input.result, content: [] });
  for (const label of input.clicks || []) {
    const b = buttons().find((x) => x.textContent.startsWith(label));
    if (!b) throw new Error("no button " + label);
    b.listeners.click.forEach((f) => f({}));
    await tick();
  }
  const texts = [];
  walk(app, (n) => { if (n instanceof Text) texts.push(n.textContent); });
  process.stdout.write(JSON.stringify({
    text: texts.join("|"),
    buttons: buttons().map((b) => b.textContent),
    messages, calls,
  }));
})().catch((e) => { process.stderr.write(String(e.stack)); process.exit(1); });
"""


def run_view(
    result: dict[str, Any], clicks: list[str] | None = None, tools: dict[str, Any] | None = None
) -> dict[str, Any]:
    executable = shutil.which("node")
    assert executable is not None
    done = subprocess.run(  # noqa: S603
        [
            executable,
            "-e",
            _RUNNER,
            str(ASSETS.joinpath("dom.js")),
            str(ASSETS.joinpath("review.js")),
        ],
        input=json.dumps({"result": result, "clicks": clicks or [], "tools": tools or {}}),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    out: dict[str, Any] = json.loads(done.stdout)
    return out


def wrapped_diff() -> str:
    diff, _ = unified_diff(
        f"one\ntwo\n{SECRET} old\nfour\n", f"one\ntwo\n{SECRET} new\nfour\n", limit=100_000
    )
    return wrap(diff, source=f"page {PAGE}")


def preview(**extra: Any) -> dict[str, Any]:
    return {
        "id": PAGE,
        "slug_id": "abc",
        "title": f"{SECRET} title",
        "url": "https://docs.example.com/p/abc",
        "dry_run": True,
        "changed": True,
        "notice": "n",
        "diff": wrapped_diff(),
        "diff_truncated": False,
        **extra,
    }


@node
def test_dry_run_renders_diff_and_sends_ids_only() -> None:
    out = run_view(preview(diff_truncated=True), clicks=["Apply this change"])
    assert f"{SECRET} old" in out["text"]
    assert f"{SECRET} new" in out["text"]
    assert "docmost-untrusted-content" not in out["text"]
    assert "cut short" in out["text"]
    assert out["buttons"][-2:] == ["Apply this change", "Discard"]
    assert len(out["messages"]) == 1
    assert PAGE in out["messages"][0]
    assert SECRET not in out["messages"][0]
    assert out["calls"] == []


@node
def test_dry_run_with_problems_offers_discard_only() -> None:
    out = run_view(preview(problems=["bad node"], diff=None, changed=False))
    assert "bad node" in out["text"]
    assert "Apply this change" not in out["buttons"]
    assert "Discard" in out["buttons"]


@node
def test_formatting_removed_notice() -> None:
    out = run_view(preview(formatting_removed=["colors"], hint="h"))
    assert "remove formatting" in out["text"]
    assert "colors" in out["text"]


@node
def test_saved_card() -> None:
    out = run_view(
        {
            "id": PAGE,
            "slug_id": "abc",
            "title": "Page",
            "url": "https://docs.example.com/p/abc",
            "snapshot_id": VERSION,
            "changed": True,
        }
    )
    assert "Saved" in out["text"]
    assert VERSION in out["text"]
    assert "Open in Docmost" in out["buttons"]
    assert "Apply this change" not in out["buttons"]


@node
def test_diff_page_restore_message() -> None:
    out = run_view(
        {
            "page_id": PAGE,
            "from_version": VERSION,
            "to_version": "current",
            "changed": True,
            "notice": "n",
            "diff": wrapped_diff(),
            "diff_truncated": False,
        },
        clicks=["Restore this version"],
    )
    assert f"{SECRET} new" in out["text"]
    assert len(out["messages"]) == 1
    assert PAGE in out["messages"][0]
    assert VERSION in out["messages"][0]
    assert SECRET not in out["messages"][0]


@node
def test_history_mode_loads_more_and_diffs() -> None:
    version = {
        "id": VERSION,
        "created_at": "2026-11-01T10:00:00+00:00",
        "title": "Old title",
        "last_updated_by": "Ann",
        "contributors": ["Ann"],
    }
    older = dict(version, id="0197a3c2-3333-7000-8000-000000000003", title="Older title")
    out = run_view(
        {
            "notice": "n",
            "page": {"id": PAGE, "slug_id": "abc", "title": "Page", "url": None, "space_id": "s"},
            "history": {"page_id": PAGE, "versions": [version], "next_cursor": "c1"},
        },
        clicks=["Load more", "Older title"],
        tools={
            "list_page_history": {"page_id": PAGE, "versions": [older], "next_cursor": None},
            "diff_page": {
                "page_id": PAGE,
                "from_version": older["id"],
                "to_version": "current",
                "changed": True,
                "diff": wrapped_diff(),
                "diff_truncated": False,
            },
        },
    )
    assert [call[0] for call in out["calls"]] == ["list_page_history", "diff_page"]
    assert out["calls"][0][1] == {"page": PAGE, "cursor": "c1", "limit": 20}
    assert out["calls"][1][1] == {"page": PAGE, "from_version": older["id"]}
    assert "Load more" not in out["buttons"]
    assert f"{SECRET} new" in out["text"]
    assert "Restore this version" in out["buttons"]
