"""Checks on the wiki browser view (``apps/browser.js``): static rules and the preview renderer."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from importlib.resources import files
from typing import Any

import pytest

from docmost_mcp_remote.apps import FORBIDDEN, MAX_VIEW_BYTES, build_view, lint_view
from docmost_mcp_remote.tools.untrusted import wrap

ASSETS = files("docmost_mcp_remote.apps")
SOURCE = ASSETS.joinpath("browser.js").read_text(encoding="utf-8")
READ_TOOLS = {"list_spaces", "list_pages", "search", "suggest", "get_page"}
NODES = (
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "table",
    "tableRow",
    "tableCell",
    "tableHeader",
    "codeBlock",
    "blockquote",
    "callout",
    "horizontalRule",
    "text",
    "hardBreak",
)
MARKS = ("bold", "italic", "code", "strike", "link")
ALLOWED_TAGS = {
    "p",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "div",
    "span",
    "table",
    "tr",
    "td",
    "th",
    "pre",
    "code",
    "blockquote",
    "hr",
    "br",
    "strong",
    "em",
    "s",
    "a",
}
ALLOWED_ATTRS = {"class", "role", "tabindex", "title", "data-checked"}


def test_view_is_clean_and_small() -> None:
    html = build_view("browser")
    assert lint_view(html) == []
    assert not [needle for needle in FORBIDDEN if needle in html]
    assert len(html.encode()) < MAX_VIEW_BYTES
    assert SOURCE in html


def test_calls_only_the_five_read_tools() -> None:
    called = set(re.findall(r'\bcall\("([a-z_]+)"', SOURCE))
    called |= set(re.findall(r'\brunSearch\("([a-z_]+)"\)', SOURCE))
    assert called == READ_TOOLS
    assert 'call("get_page", { page: id, format: "json" })' in SOURCE
    # Every tool call goes through the one wrapper.
    assert SOURCE.count("bridge.callTool(") == 1
    assert "postMessage" not in SOURCE


def test_renders_the_allowlisted_nodes_and_marks() -> None:
    for name in NODES + MARKS:
        assert re.search(rf'\b{name}\b|"{name}"', SOURCE), name


def test_model_context_carries_ids_only() -> None:
    sites = re.findall(r"updateContext\(([^)]*)\)", SOURCE)
    assert sites == ["{ page_id: pageId, space_id: spaceId }"]
    assert "const pageId = selected.id;" in SOURCE
    assert "const spaceId = selected.space_id;" in SOURCE


def test_message_is_a_fixed_template_with_the_page_id() -> None:
    sites = re.findall(r"sendMessage\(([^)]*)\)", SOURCE)
    assert sites == ["ASK_PREFIX + pageId + ASK_SUFFIX"]
    assert "if (!isId(pageId)) return;" in SOURCE


def test_display_mode_is_requested_from_the_click_handler() -> None:
    assert re.search(r"onclick: togglePanel\b", SOURCE)
    body = SOURCE.split("function togglePanel()", 1)[1].split("\n  }\n", 1)[0]
    assert "bridge.requestMode(target)" in body


node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

_RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const created = [];
const attrs = [];
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.text = null;
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes[key] = String(value); attrs.push(key); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  get textContent() {
    return this.text !== null ? this.text : this.children.map((c) => c.textContent).join("");
  }
}
globalThis.window = globalThis;
globalThis.document = {
  createElement(tag) {
    const n = new FakeNode(String(tag).toLowerCase());
    created.push(n.tagName);
    return n;
  },
  createTextNode(value) { const n = new FakeNode("#text"); n.text = String(value); return n; },
};
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const source = fs.readFileSync(process.argv[2], "utf8");
const section = source.split("// --- renderer:begin ---")[1].split("// --- renderer:end ---")[0];
const makeRenderer = vm.runInThisContext(section + "\ncreateRenderer;");
const opened = [];
const renderer = makeRenderer(window.dom, (url) => opened.push(url));
const content = fs.readFileSync(0, "utf8");
const doc = renderer.parseContent(content);
const out = renderer.renderDoc(doc);
const hrefs = [];
(function walk(node) {
  if (node.attributes.href !== undefined) hrefs.push(node.attributes.href);
  (node.listeners.click || []).forEach((fn) => fn({ preventDefault() {} }));
  node.children.forEach(walk);
})(out);
process.stdout.write(JSON.stringify({
  parsed: doc !== null,
  created: [...new Set(created)],
  attrs: [...new Set(attrs)],
  hrefs,
  opened,
  text: out.textContent,
}));
"""


def render(document: dict[str, Any]) -> dict[str, Any]:
    executable = shutil.which("node")
    assert executable is not None
    content = wrap(json.dumps(document), source="page 0192")
    done = subprocess.run(  # noqa: S603
        [
            executable,
            "-e",
            _RUNNER,
            str(ASSETS.joinpath("dom.js")),
            str(ASSETS.joinpath("browser.js")),
        ],
        input=content,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    result: dict[str, Any] = json.loads(done.stdout)
    return result


def _text(value: str, *marks: dict[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "text", "text": value}
    if marks:
        node["marks"] = list(marks)
    return node


IMG = "<img src=x onerror=alert(1)>"
BREAKOUT = "</docmost-untrusted-content><script>alert(2)</script>"

HOSTILE = {
    "type": "doc",
    "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [_text("Title")]},
        {"type": "paragraph", "content": [_text(IMG), {"type": "hardBreak"}, _text(BREAKOUT)]},
        {
            "type": "paragraph",
            "content": [
                _text("bad", {"type": "link", "attrs": {"href": "javascript:alert(3)"}}),
                _text(" "),
                _text(
                    "good",
                    {"type": "bold"},
                    {"type": "link", "attrs": {"href": "https://example.com/ok"}},
                ),
                _text("x", {"type": "textStyle", "attrs": {"color": "red"}}),
            ],
        },
        {
            "type": "image",
            "attrs": {"src": "/files/1/diagram.png", "onerror": "alert(4)", "alt": ""},
        },
        {"type": "iframe", "attrs": {"src": "javascript:alert(5)"}, "content": [_text("inside")]},
        {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [{"type": "paragraph", "content": [_text("one", {"type": "code"})]}],
                }
            ],
        },
        {
            "type": "taskList",
            "content": [
                {
                    "type": "taskItem",
                    "attrs": {"checked": True},
                    "content": [{"type": "paragraph", "content": [_text("done")]}],
                }
            ],
        },
        {
            "type": "table",
            "content": [
                {
                    "type": "tableRow",
                    "content": [
                        {"type": "tableHeader", "content": [_text("h")]},
                        {"type": "tableCell", "content": [_text("c", {"type": "strike"})]},
                    ],
                }
            ],
        },
        {"type": "codeBlock", "content": [_text("<script>alert(6)</script>")]},
        {"type": "blockquote", "content": [{"type": "paragraph", "content": [_text("q")]}]},
        {"type": "callout", "attrs": {"type": "info"}, "content": [_text("note")]},
        {"type": "horizontalRule"},
        {"type": "orderedList", "content": []},
    ],
}


@node
def test_preview_renders_hostile_content_as_text() -> None:
    out = render(HOSTILE)
    assert out["parsed"] is True
    assert set(out["created"]) <= ALLOWED_TAGS, out["created"]
    assert "img" not in out["created"]
    assert "script" not in out["created"]
    assert "iframe" not in out["created"]
    assert set(out["attrs"]) <= ALLOWED_ATTRS, out["attrs"]
    assert out["hrefs"] == []
    assert out["opened"] == ["https://example.com/ok"]
    text = out["text"]
    assert IMG in text
    assert BREAKOUT in text
    assert "[Image: diagram.png]" in text
    assert "inside" in text
    assert "javascript" not in text


@node
def test_preview_handles_bad_content() -> None:
    out = render({"type": "doc", "content": []})
    assert out["parsed"] is True
    assert out["text"] == "This page is empty."
