"""Interactive views (MCP Apps): self-contained HTML assembled from package files.

Each view is one HTML shell (``<name>.html``) with two placeholders. ``build_view``
replaces ``/*__BASE_CSS__*/`` with ``base.css`` and ``/*__SCRIPTS__*/`` with
``bridge.js``, ``dom.js`` and ``<name>.js``, in that order. The result has no
external URL and is linted for HTML-injection APIs (``lint_view``).
"""

from __future__ import annotations

import hashlib
from importlib.resources import files

VIEW_NAMES: tuple[str, ...] = ("browser", "review")
MAX_VIEW_BYTES = 200_000
FORBIDDEN: tuple[str, ...] = (
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "eval(",
    "new Function",
    "http://",
    "https://",
)

_CSS_SLOT = "/*__BASE_CSS__*/"
_SCRIPT_SLOT = "/*__SCRIPTS__*/"
_ASSETS = files("docmost_mcp_remote.apps")


def _read(name: str) -> str:
    return _ASSETS.joinpath(name).read_text(encoding="utf-8")


def _assemble(name: str) -> str:
    shell = _read(f"{name}.html")
    css = _read("base.css")
    scripts = "\n".join((_read("bridge.js"), _read("dom.js"), _read(f"{name}.js")))
    if "</style" in css.lower() or "</script" in scripts.lower():
        raise ValueError(f"view {name!r}: an asset closes its own element")
    for slot in (_CSS_SLOT, _SCRIPT_SLOT):
        if shell.count(slot) != 1:
            raise ValueError(f"view {name!r}: {slot} must appear exactly once")
    return shell.replace(_CSS_SLOT, css).replace(_SCRIPT_SLOT, scripts)


_VIEWS: dict[str, str] = {name: _assemble(name) for name in VIEW_NAMES}
_URIS: dict[str, str] = {
    name: f"ui://docmost/{name}-{hashlib.sha256(html.encode()).hexdigest()[:8]}.html"
    for name, html in _VIEWS.items()
}


def build_view(name: str) -> str:
    """The assembled HTML of view ``name``. Raises ``KeyError`` for an unknown name."""
    return _VIEWS[name]


def view_uri(name: str) -> str:
    """The content-addressed ``ui://`` URI of view ``name``."""
    return _URIS[name]


def lint_view(html: str) -> list[str]:
    """The forbidden needles found in ``html``; an empty list means clean."""
    return [needle for needle in FORBIDDEN if needle in html]
