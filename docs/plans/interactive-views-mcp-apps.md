# Plan: interactive views (MCP Apps)

Status: approved for implementation, not started.
Researched: 2026-11-22. Facts about hosts and SDKs in the appendix were read from primary
sources on that date; re-check anything marked "unverified" before relying on it.

This document is written for the agent or person who implements the change. It is
self-contained: the appendix holds the protocol and API facts that are not in the code base.

## 1. Context

Claude's "interactive connectors" run on MCP Apps (extension id
`io.modelcontextprotocol/ui`). A tool declares `_meta.ui.resourceUri`, the server serves a
`ui://` HTML resource with MIME type `text/html;profile=mcp-app`, and the host renders it in a
sandboxed iframe that talks to the host over postMessage JSON-RPC. The 10 November 2026
launch added the side panel, entry points, app tools and embedded sites.

This server is text-only today: 62 tools that return dicts, no tool `_meta`, no `ui://`
resources, no frontend build tooling.

Goal: add a wiki browser, a change-review view and, later, a page view for editing alongside
Claude.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Views | Wiki browser, change review, co-editing page view |
| Writes from the UI | Read-only first. UI writes only in Phase 3, behind its own flag and a separate go decision |
| Target | Upstream-ready: feature flag default off, ADR, `README.ru.md` mirrored, no deployment-specific choices |
| Spike | None. No separate real-host test before building (see section 6) |
| Frontend tooling | None. Hand-written vanilla JS, inlined into one HTML string per view. No bundler, no CDN, no npm dependency |

## 3. Constraints from research

- Claude shows no approval prompt when a view calls the connector's own tools. Tool
  `visibility` is a UX hint, not a security boundary: the server cannot tell a model call from
  a view call. `tools/confirm.py` lets a change through when the host cannot elicit.
  Consequence: no destructive tool may become a silent one-click action from a view.
- The default iframe CSP allows inline script and blocks all external origins. Bundle
  everything inline. Declare no `connectDomains`, `resourceDomains` or `frameDomains`.
- Docmost text reaches the client inside the `<docmost-untrusted-content>` envelope
  (`tools/untrusted.py`), with only the closing tag neutralised. It is not HTML-escaped.
  Views must render with `createElement` and `textContent` only.
- Entry points, the side panel, app tools and embedded sites are limited to some
  organizations. Treat them as progressive enhancement. The core design must work with
  `inline` and `fullscreen` only.
- Claude can cache a connector's tool list for up to about two hours. After a deploy, use
  Customize, Connectors, the connector's menu, "Refresh tools list".
- Open risk: ext-apps issue 671 (views not rendering in Claude; some reporters use FastMCP).
  Unresolved upstream as of the research date.

## 4. Architecture

### 4.1 Package layout (new)

```
src/docmost_mcp_remote/apps/
  __init__.py        build_view(name) -> str   assembles one self-contained HTML string
  bridge.js          hand-written MCP Apps bridge
  dom.js             safe DOM helpers: el(), text(), unwrap(), safeHref(), parseUnifiedDiff()
  base.css           host CSS variables, transparent background, light and dark
  browser.html/.js   wiki browser view
  review.html/.js    change-review view
  page.html/.js      co-editing page view (Phase 3)
src/docmost_mcp_remote/tools/views.py   register(mcp, settings, members): ui:// resources and open_* tools
```

- Load assets at import time with `importlib.resources.files(...)`, the pattern in
  `web/uploads.py:55` and `web/routes.py:54`. Hatch already ships non-`.py` package files;
  the Dockerfile installs from the built wheel.
- `build_view` inlines `base.css`, `bridge.js`, `dom.js` and the view script into the HTML
  shell. Resource URIs carry a content hash, for example `ui://docmost/browser-<sha8>.html`,
  so a changed view never collides with a host-side cache.
- No `ui.domain`, no external origins, no `permissions`. `prefersBorder: false`.
- `tools/views.py` follows `tools/navigate.py` and `tools/health.py`: a `register(...)`
  function, nested closures, `as_member(members, action)`, `SpacePolicy`,
  `auth=require_scopes("read")`, annotation constants.

### 4.2 Bridge (`bridge.js`)

About 200 lines, an IIFE with `"use strict"`, in the style of `web/upload.js`.

- Handshake: send `ui/initialize` with `protocolVersion: "2026-01-26"`, `appInfo`, and
  `appCapabilities.availableDisplayModes: ["inline", "fullscreen"]`; on the result send
  `ui/notifications/initialized`. Never list a mode other than `inline`, `fullscreen`, `pip`:
  Claude fails `ui/initialize` on unknown values.
- Receives `ui/notifications/tool-input`, `tool-result`, `tool-cancelled`,
  `host-context-changed`, and the request `ui/resource-teardown`. Answers `ping`.
- Sends `tools/call`, `ui/notifications/size-changed` (from a `ResizeObserver`),
  `ui/update-model-context`, `ui/message`, `ui/open-link`, `ui/request-display-mode`.
- Applies `hostContext.theme` and `hostContext.styles.variables`; reads `displayMode` and
  `containerDimensions` to switch between compact and two-pane layout.
- Exposes a small API to the views and nothing else: `onToolInput`, `onToolResult`,
  `callTool`, `sendMessage`, `updateContext`, `openLink`, `requestMode`, `hostContext`.
  Views never touch `postMessage` directly. This keeps the contingency a one-file swap.
- Contingency, only if the hand-written bridge fails in a real host: vendor
  `@modelcontextprotocol/ext-apps@1.7.5` `dist/src/app-with-deps.js` (MIT, about 337 KB)
  inline, pinned by SHA-256, credited in `NOTICE`, and re-implement the same small API on it.

### 4.3 Feature flags (`config.py`, `.env.example`)

| Setting | Default | Effect |
|---|---|---|
| `INTERACTIVE_VIEWS` | `false` | When false, `views.register` is not called and no existing tool gains `_meta.ui`. Tool and resource lists are identical to 1.2.3 |
| `INTERACTIVE_EDITING` | `false` | Phase 3 only. Enables Save from the page view. Requires `INTERACTIVE_VIEWS` |

### 4.4 Security rules for all views

These go into `docs/security-model.md` as a new trust boundary (the view iframe).

1. DOM text APIs only. A pytest lints each assembled view for `innerHTML`, `outerHTML`,
   `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, and any `http://` or
   `https://` URL.
2. `unwrap()` strips the envelope for display only. Wiki text never goes into `ui/message`
   or `ui/update-model-context`. Those carry fixed template strings plus server-generated
   ids. Claude re-reads content through the normal wrapped tools.
3. Links: `safeHref()` allows `https:` and `http:` only, and every link goes through
   `ui/open-link`. No images in the first version (placeholder with the file name).
4. Views call only tools that the grant's scopes allow. Server-side
   `auth=require_scopes(...)`, `SpacePolicy`, and the `ToolGuard` rate limit and audit apply
   unchanged.
5. `ui://` resources use `auth=require_scopes("read")` and contain no member data.
6. No trash, move, restore, people or admin action is ever callable as a button in a view.

## 5. Phases

### Phase 1: foundation and wiki browser (read-only)

Foundation:

1. `uv sync`. Confirm the `fastmcp.apps` API in the locked version (appendix A.3). If it is
   absent in 4.1.3, raise the lower bound to the first 4.x release that has it and re-lock.
   `pip-audit --strict` must pass.
2. Add `INTERACTIVE_VIEWS`, the `apps/` package, `build_view`, `bridge.js`, `dom.js`,
   `base.css`.
3. Add `tools/views.py`. Call it in `server.py` after `resources.register(...)`, behind the
   flag. Add one sentence about the views to `INSTRUCTIONS` only when the flag is on.
4. `tests/harness.py`: add a helper that returns raw `list_tools()` entries (to read
   `.meta`), a helper that reads a resource with its `mimeType` and `_meta`, and a
   `make_settings` option for the flag.
5. Write `docs/adr/0007-interactive-views-mcp-apps.md`.

Browser:

- New model-visible tool `open_wiki(space_id=None, page=None, query=None)`. Scope `read`,
  read-only annotations, every argument optional, useful with `{}`. It returns
  `{notice, spaces: [...], selected: {...}}` so a text-only host still gets a useful answer.
- Entry point on `open_wiki`: `_meta["openai/ui"] = {"entrypoints": [{"type": "global"}]}`.
  Title "Docmost wiki" (60 characters or fewer, no "Claude" or "Anthropic"). Tool name
  without `__` or `..`.
- The view calls existing tools through the host. No new data tools:
  `list_spaces`, `list_pages` (flat, with `has_children`, used for a lazy tree), `search`,
  `suggest`, `get_page(format="json")`.
- Page preview renders the ProseMirror JSON with a node-type allowlist in `browser.js`:
  paragraph, heading, bullet and ordered list, task list, table, code block, blockquote,
  callout, horizontal rule; marks bold, italic, code, strike, link. An unknown node renders
  as the plain text of its children.
- Layout: `inline` shows a search box and a result list. `fullscreen` (also the side panel)
  shows tree, search and preview. An "Open in panel" button calls
  `ui/request-display-mode` directly inside its click handler.
- Buttons: "Open in Docmost" (`ui/open-link` to the page URL) and "Ask Claude about this
  page" (`ui/message`, fixed template plus the page id).
- On selection, send `ui/update-model-context` with `{page_id, space_id}` only.
- Handle `truncated`, `next_cursor`, empty and error states, keyboard navigation, and a
  320 px width.

### Phase 2: change review (read-only)

- When the flag is on, attach the review view to `diff_page`, `update_page`,
  `replace_section` and `replace_page_json`. Their return dicts do not change. Implement it
  by passing an optional `app` value from `views.py` into `history.register` and
  `write.register`.
- `review.js` unwraps and parses the unified diff (format of `sections.unified_diff`:
  labels `current` and `proposed`, two context lines) into hunks. It shows `diff_truncated`,
  `formatting_removed` and `problems`. For a result that is not a dry run it shows a compact
  "Saved" card with title, link and `snapshot_id`.
- Buttons send `ui/message` with fixed templates, so the write stays with Claude and the
  normal approval prompt: "Apply this change", "Discard", and for `diff_page` "Restore this
  version". The view calls no write tool.
- New model-visible tool `open_page_history(page)`: a version list that calls
  `list_page_history` and `diff_page` from the view.

### Phase 3: co-editing page view (separate go decision; needs `INTERACTIVE_EDITING`)

- New model-visible tool `open_page(page)`, scope `read`, resource `page.html`. The view
  declares `fullscreen` so Claude opens it in the side panel where that exists.
- New app-only tool `page_status(page)` with `visibility=["app"]`, returning
  `{id, updated_at, last_updated_by}`. The view polls it every 15 seconds while visible
  (4 calls per minute against the default limit of 60) and reloads the body when Claude or
  another member changes the page.
- Supersession: the server adds `{created_at, seq}` to `open_page` results. Views announce
  it on a `BroadcastChannel`; only the newest instance polls and updates model context.
- Context sharing: `ui/update-model-context` with `{page_id, section_index, section_hash}`,
  so "rewrite this section" resolves without wiki text passing through the view.
- User edits are per section, in Markdown: `get_section` fills a textarea; "Preview" calls
  `replace_section(dry_run=true)` and renders the diff with the Phase 2 code. Section
  editing is disabled when the page reports `markdown_loses`.
- Save path: the view calls `replace_section` with the `section_hash` it loaded. Existing
  safeguards apply: a hash mismatch refuses the write when the section changed meanwhile, a
  snapshot is taken first, and the read-back check runs. This needs scope `write` and
  `INTERACTIVE_EDITING=true`. Otherwise the Save button uses the Phase 2 "Apply"
  `ui/message` path.
- Out of scope: WYSIWYG editing (needs TipTap and a bundler), images, comments, embedding
  the Docmost site itself (`frameDomains`; needs header and cookie changes in Docmost), and
  app tools.

## 6. Why there is no spike

The design does not depend on the open host questions.

| Open question | Why it does not block |
|---|---|
| Does Claude send `capabilities.extensions`? | Tools never branch on it. Every tool always returns its full dict, so text-only hosts work unchanged |
| Does the model see `content` or `structuredContent`? | Both carry the same dict (FastMCP default), as today |
| Does `meta=` merge with `app=` for the entry-point key? | A unit test on `list_tools()` checks it. If it does not merge, build the `_meta` dict by hand with `app_config_to_meta_dict` |
| Does the hand-written bridge work in Claude? | Verified locally against the ext-apps reference host. Views use only the small bridge API, so the vendored-SDK contingency replaces one file |

Accepted trade-off: the first test in real Claude happens when Phase 1 is deployed with
`INTERACTIVE_VIEWS=true`. If views do not render there, rework is confined to `bridge.js`
and the resource meta, and turning the flag off restores 1.2.3 behaviour.

## 7. Files to change

| File | Change |
|---|---|
| `src/docmost_mcp_remote/config.py`, `.env.example` | Two flags |
| `src/docmost_mcp_remote/apps/*` | New: assets and `build_view` |
| `src/docmost_mcp_remote/tools/views.py` | New: resources and `open_*` tools |
| `src/docmost_mcp_remote/server.py` | Call `views.register` behind the flag; conditional sentence in `INSTRUCTIONS` |
| `src/docmost_mcp_remote/tools/write.py`, `tools/history.py` | Optional `app` argument on four tools (Phase 2) |
| `tests/harness.py` | Raw tool and resource meta helpers; flag in `make_settings` |
| `tests/test_view_tools.py` (new) | Tool meta, MIME type, resource meta, scope hiding, fallback text, HTML lint, size limit (under 200 KB per view) |
| `tests/test_read_tools.py`, `tests/test_resources_prompts.py` | Exact lists unchanged with the flag off; a second expected list with the flag on |
| `README.md`, `README.ru.md` | New "Interactive views" section, tool table rows and tool count, client notes, flags |
| `docs/security-model.md`, `docs/DESIGN.md`, `docs/adr/0007-*.md`, `CHANGELOG.md` | Trust boundary, design notes, ADR, `[Unreleased]` entry |
| `pyproject.toml`, `uv.lock`, `NOTICE` | Only if a FastMCP bump or the vendored-SDK contingency is needed |

Reuse as is: `as_member` and `page_link` (`tools/common.py`), `SpacePolicy`
(`tools/spaces.py`), `NOTICE` and `wrap` (`tools/untrusted.py`), `require_scopes`,
`ToolGuard` (`guard.py`), `unified_diff` (`sections.py`), `preview()` and `result()`
(`tools/write.py`).

Tests that assert exact lists and will fail if the flag-off behaviour changes:
`tests/test_read_tools.py:121-154` (read-scope tool list) and
`tests/test_resources_prompts.py:58-59` (resource list). Both READMEs state "62 tools".

## 8. Verification

1. `uv run ruff format --check . && uv run ruff check . && uv run mypy` (strict).
2. `uv run pytest` with `DATABASE_TEST_URL` set (Postgres 17, as in CI). New tests cover
   both flag states. With the flag off, the tool and resource lists equal today's.
3. Hostile-content check without a real host: a throwaway fake-host page (not committed)
   loads each built view in a sandboxed iframe under Playwright and Chromium, performs the
   handshake, and feeds recorded tool results that contain hostile titles and bodies
   (`<img onerror>`, `javascript:` links, envelope break-out attempts). Assert that no script
   runs and no network request leaves the frame. Take light and dark screenshots.
4. Reference host: run the server locally with a fake Docmost and `INTERACTIVE_VIEWS=true`,
   connect ext-apps `examples/basic-host`, and drive each view with Playwright. Protocol
   check with `npx @modelcontextprotocol/inspector --cli <url> --transport http --method
   tools/list` and its `--app-info` option.
5. Real host, once per phase after deployment (maintainer): set `INTERACTIVE_VIEWS=true`,
   use "Refresh tools list" on the connector, then in Claude Desktop (Help, Troubleshooting,
   Enable Developer Mode gives the iframe console): open the browser inline and in the
   panel, search, preview a page, run a dry-run edit and apply it through Claude, and confirm
   that the approval prompt still appears for the write.
6. Docker: `docker build` and the compose smoke test; confirm the `apps/` assets are in the
   image.

## 9. Delivery

- One commit series per phase. Phases 1 and 2 run back to back. Phase 3 starts only on an
  explicit go.
- Changes to `web/`, `oauth.py`, `auth.py`, `tools/write.py` and `db/` get extra review
  (`CONTRIBUTING.md`). This plan touches `tools/write.py` only to pass the optional `app`
  argument.
- No pull request unless the maintainer asks for one.

## Appendix A: reference facts for the implementer

### A.1 Wire format (spec `2026-01-26`, stable)

- Tool: `_meta.ui = {"resourceUri": "ui://...", "visibility": ["model", "app"]}`. Default
  visibility is both. A tool without `"model"` is hidden from the agent; a tool without
  `"app"` cannot be called by a view. The flat key `_meta["ui/resourceUri"]` is deprecated.
- Resource: URI starts with `ui://`; MIME type `text/html;profile=mcp-app`; HTML in `text`.
- Resource `_meta.ui` (on the `resources/read` content item): `csp` (`connectDomains`,
  `resourceDomains`, `frameDomains`, `baseUriDomains`), `permissions`, `domain`,
  `prefersBorder`. Claude ignores `baseUriDomains`.
- Default CSP when none is declared: `default-src 'none'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:;
  connect-src 'none'`.
- Client capability: `capabilities.extensions["io.modelcontextprotocol/ui"] =
  {"mimeTypes": ["text/html;profile=mcp-app"]}`.
- A UI tool must still return a meaningful `content` array.

### A.2 View and host messages

| Direction | Method | Notes |
|---|---|---|
| View to host, request | `ui/initialize` | Params `appInfo`, `appCapabilities`, `protocolVersion`. Result `protocolVersion`, `hostInfo`, `hostCapabilities`, `hostContext` |
| View to host, notification | `ui/notifications/initialized` | Host sends nothing before this |
| Host to view, notification | `ui/notifications/tool-input` | `{arguments}`, once, before the result |
| Host to view, notification | `ui/notifications/tool-input-partial` | Zero or more, while streaming |
| Host to view, notification | `ui/notifications/tool-result` | Params are a `CallToolResult` |
| Host to view, notification | `ui/notifications/tool-cancelled` | `{reason}` |
| Host to view, notification | `ui/notifications/host-context-changed` | Partial host context |
| Host to view, request | `ui/resource-teardown` | `{reason}`. Claude on the web does not send it |
| View to host, request | `tools/call` | Standard MCP. No approval prompt in Claude |
| View to host, request | `ui/message` | `{role: "user", content}`. Text only, 8,000 characters or fewer, only on a user action. Claude asks the user or puts it in the message box |
| View to host, request | `ui/update-model-context` | `{content?, structuredContent?}`. Each call overwrites the last |
| View to host, request | `ui/open-link` | `{url}`. Custom connectors always get a confirmation modal |
| View to host, request | `ui/request-display-mode` | `{mode}`. Needs a recent click or key press; result is the mode actually set |
| View to host, notification | `ui/notifications/size-changed` | `{width, height}`. A zero-height view never appears |

Host context fields: `toolInfo`, `theme` (`light` or `dark`), `styles.variables`,
`displayMode`, `availableDisplayModes`, `containerDimensions` (`{width, maxHeight}` inline,
`{width, height}` fullscreen), `locale`, `timeZone`, `platform`, `safeAreaInsets`.

Claude offers `inline` and `fullscreen`, not `pip`. The side panel reports `fullscreen`. A
new fullscreen view must send `initialized` within 15 seconds of load start to replace an
open one.

### A.3 FastMCP 4.x API (from docs and `main` source; verify after `uv sync`)

```python
from fastmcp.apps import AppConfig, ResourceCSP, UI_EXTENSION_ID, app_config_to_meta_dict
from fastmcp.tools import ToolResult

@mcp.tool(app=AppConfig(resource_uri="ui://docmost/browser-<sha8>.html"))
async def open_wiki(...) -> dict[str, Any]: ...

@mcp.tool(app=AppConfig(resource_uri="ui://docmost/page-<sha8>.html", visibility=["app"]))
async def page_status(...) -> dict[str, Any]: ...

@mcp.resource("ui://docmost/browser-<sha8>.html", app=AppConfig(prefers_border=False))
def browser_view() -> str:
    return build_view("browser")
```

- `ui://` resources default to the Apps MIME type. FastMCP copies resource meta onto each
  `resources/read` content item and advertises the server extension itself.
- `ctx.client_supports_extension(UI_EXTENSION_ID)` exists, but a FastMCP source comment says
  extensions can be stripped on pre-2026 protocol connections. Do not branch on it.
- Unverified: that `meta={...}` and `app=AppConfig(...)` merge on one tool.
- The installed `mcp` 2.3.0 package has `mcp/server/apps.py` (`Apps`, `ResourceCsp`,
  `client_supports_apps`). It targets the SDK's own server class, not FastMCP; use it only
  as a wire-format reference.

### A.4 Claude theming and layout

- `html, body { background: transparent }`, `<meta name="color-scheme" content="light dark">`.
- Required: light and dark themes from host tokens, no hard-coded colours; WCAG AA
  contrast; keyboard navigation.
- Main variables: `--color-background-{primary,secondary,tertiary}`,
  `--color-text-{primary,secondary,tertiary,danger}`,
  `--color-border-{primary,secondary,tertiary}`, `--font-sans`, `--font-mono`,
  `--font-text-{xs,sm,md,lg}-size`, `--font-weight-{normal,medium,semibold,bold}`,
  `--border-radius-{xs,sm,md,lg,xl,full}`, `--border-width-regular`.
- Recommended for inline cards: at most two actions, four or five data points, no nested
  scrolling, no popovers. The host caps inline height and clips the rest.
- Entry-point icon, if added: inline `data:image/png;base64,` URI, 64 to 128 px, under 10 KB.

### A.5 Sources

- MCP Apps overview: https://modelcontextprotocol.io/docs/extensions/apps
- Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- Reference host and testing: https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/testing-mcp-apps.md
- Rendering issue: https://github.com/modelcontextprotocol/ext-apps/issues/671
- Claude docs index: https://claude.com/docs/llms.txt (pages under
  `/docs/connectors/building/mcp-apps/`: `getting-started`, `quickstart`,
  `design-guidelines`, `display-modes`, `entry-points`, `app-tools`, `send-messages`,
  `embedded-sites`, `transparent-theming`, `instance-supersession`, `external-links`,
  `troubleshooting`; plus `/docs/connectors/building/testing`)
- Launch post: https://claude.com/blog/interactive-connectors-full-tool
- FastMCP apps docs: https://gofastmcp.com/docs/apps/overview
