# Plan: interactive views (MCP Apps), Phases 1 and 2

Branch: `claude/laughing-gauss-gxcpu9`
Source plan: [`docs/plans/interactive-views-mcp-apps.md`](../interactive-views-mcp-apps.md)
(the "source plan" below). It holds the design, the security rules (section 4.4) and the
protocol facts (appendix A). This file slices its Phases 1 and 2 for the multi-agent
workflow in `CLAUDE.md`. Phase 3 is not sliced: it waits for a separate go decision from the
user and is listed under Deferred in `PROGRESS.md`.

Every slice agent reads this whole file, its own slice, and the source plan sections its
slice names. Nothing else is needed to start.

## Shared facts for all slices

- Package: `src/docmost_mcp_remote/`. Python 3.12, FastMCP 4.1.3 (locked). Strict mypy.
- `fastmcp.apps` exists in the locked 4.1.3 and exports `AppConfig`, `ResourceCSP`,
  `ResourcePermissions`, `UI_EXTENSION_ID`, `UI_MIME_TYPE`, `app_config_to_meta_dict`,
  `resolve_ui_mime_type` (checked by the planner on 2026-11-22). No dependency bump is planned.
  If a slice finds otherwise, it stops and reports blocked; it does not change `pyproject.toml`
  or `uv.lock`.
- Feature flag: `Settings.interactive_views: bool = False` (env `INTERACTIVE_VIEWS`). With it
  off, the tool list, resource list and every tool's `_meta` must equal today's (1.2.3).
  The existing exact-list tests `tests/test_read_tools.py::test_tool_list` and
  `tests/test_resources_prompts.py::test_resources_are_listed` are the flag-off guard. No
  slice edits them.
- Tool registration pattern: see `tools/navigate.py` and `tools/health.py`. A
  `register(mcp, settings, members)` function with nested closures, `as_member(members, action)`
  from `tools/common.py`, `SpacePolicy(settings.allowed_spaces)` from `tools/spaces.py`,
  `auth=require_scopes("read")`, and a module-level
  `_READ_ONLY = {"readOnlyHint": True, "openWorldHint": False}`.
- Untrusted envelope (`tools/untrusted.py`): wiki text arrives as
  `<docmost-untrusted-content source="...">\n...\n</docmost-untrusted-content>`; inside, a
  closing tag is written as `&lt;/docmost-untrusted-content`. Nothing else is HTML-escaped.
- Unified diff format (`sections.unified_diff`): `difflib.unified_diff` with labels
  `current` and `proposed`, `n=2`, joined with `\n`, possibly cut at a character limit
  (then `diff_truncated: true`).
- Server test harness: `tests/harness.py::RunningServer(docmost, **settings)` runs the real
  app; `token(scopes=...)`, `tools(token)`, `call(token, tool, args)`, `resources(token)`,
  `read(token, uri)`. `tests/conftest.py::make_settings(**overrides)` builds `Settings`.
  Server-backed tests use the `engine` fixture and **skip when `DATABASE_TEST_URL` is not
  set** (Postgres 17 as in `.github/workflows/ci.yml`). A slice whose server tests all skip
  reports the skip count; it does not count as passing. The orchestrator confirms whether
  `DATABASE_TEST_URL` is available before wave 2.
- Node 22 is present on the planner's machine and on GitHub runners. Python tests may run
  `node` through `subprocess` for pure JS helpers, guarded by
  `pytest.mark.skipif(shutil.which("node") is None, ...)`. No `package.json`, no npm, no CDN.
- Security rules (source plan 4.4) apply to every view slice: DOM text APIs only
  (`createElement`, `textContent`, `setAttribute` on safe attributes); wiki text never goes
  into `ui/message` or `ui/update-model-context`; links only through `safeHref()` and
  `ui/open-link`; no images (placeholder with file name); the view calls only read tools; no
  trash, move, restore, people or admin button.
- Lint and types for every slice: `uv run ruff format --check . && uv run ruff check . && uv run mypy`.

## Shared interfaces (defined here, owned by the slice named)

### I1. `docmost_mcp_remote.apps` (owner S1)

```python
VIEW_NAMES: tuple[str, ...] = ("browser", "review")
def build_view(name: str) -> str: ...      # one self-contained HTML string; KeyError for unknown name
def view_uri(name: str) -> str: ...        # "ui://docmost/<name>-<sha8>.html", sha8 = sha256(build_view(name)).hexdigest()[:8]
FORBIDDEN: tuple[str, ...]                 # lint needles, see S1
def lint_view(html: str) -> list[str]: ... # needles found; [] means clean
MAX_VIEW_BYTES = 200_000
```

Assets are loaded once at import with `importlib.resources.files("docmost_mcp_remote.apps")`
(pattern: `web/routes.py:54`, `web/uploads.py:55`). `build_view(name)` reads `<name>.html`,
which contains the placeholders `/*__BASE_CSS__*/` (inside `<style>`) and
`/*__SCRIPTS__*/` (inside one `<script>`), and replaces them with `base.css` and with
`bridge.js` + `dom.js` + `<name>.js` in that order. Output is deterministic.

### I2. Bridge JS API (owner S1, file `apps/bridge.js`)

An IIFE with `"use strict"` that defines `window.mcpBridge` and nothing else global:

| Member | Contract |
|---|---|
| `start(appInfo)` | Sends `ui/initialize` (`protocolVersion: "2026-01-26"`, `appInfo`, `appCapabilities.availableDisplayModes: ["inline", "fullscreen"]`), stores the result, applies theme and style variables, sends `ui/notifications/initialized`, starts a `ResizeObserver` that sends `ui/notifications/size-changed`. Returns a Promise of the host context |
| `onToolInput(fn)` | `fn(arguments)` on `ui/notifications/tool-input` |
| `onToolResult(fn)` | `fn(callToolResult)` on `ui/notifications/tool-result` |
| `onToolCancelled(fn)` | `fn(reason)` |
| `onHostContext(fn)` | `fn(hostContext)` after every merge of `host-context-changed` |
| `hostContext()` | Current merged host context object |
| `callTool(name, args)` | `tools/call`; resolves to the `CallToolResult`; rejects on JSON-RPC error |
| `structured(result)` | `result.structuredContent`, else `JSON.parse` of the first text content item, else `null` |
| `sendMessage(text)` | `ui/message` with `{role: "user", content: [{type: "text", text}]}`; text over 8000 characters is refused |
| `updateContext(structuredContent)` | `ui/update-model-context` with `{structuredContent}` |
| `openLink(url)` | `ui/open-link`; refuses a url that `dom.safeHref` rejects |
| `requestMode(mode)` | `ui/request-display-mode`; resolves to the mode actually set |

It answers `ping` and `ui/resource-teardown` (empty result), ignores messages whose
`source` is not `window.parent`, and never lists a display mode other than `inline` or
`fullscreen`. Views never call `postMessage`.

### I3. DOM helpers (owner S1, file `apps/dom.js`)

An IIFE defining `window.dom`:

| Member | Contract |
|---|---|
| `el(tag, attrs, ...children)` | `createElement`; `attrs` keys limited to `class`, `id`, `role`, `type`, `title`, `tabindex`, `aria-*`, `data-*`, and `on<event>` functions (added with `addEventListener`); any other key throws. Children: strings become text nodes, nodes are appended, `null` skipped |
| `text(value)` | `document.createTextNode(String(value ?? ""))` |
| `unwrap(s)` | Strips one surrounding envelope and its leading and trailing newline, and turns `&lt;/docmost-untrusted-content` back into `</docmost-untrusted-content`. A string without an envelope is returned unchanged. For display only |
| `safeHref(url)` | The normalised URL string when its protocol is `https:` or `http:`, else `null` |
| `parseUnifiedDiff(text)` | `[{header, oldStart, oldLines, newStart, newLines, lines: [{kind: "context"\|"add"\|"del", text}]}]`; skips the `---`/`+++` file lines; tolerates a cut last hunk |

### I4. Harness helpers (owner S2, file `tests/harness.py`)

```python
def RunningServer.tool_entries(self, token: str) -> list[mcp.types.Tool]   # raw list_tools() entries, with .meta
def RunningServer.read_resource(self, token: str, uri: str) -> tuple[str, str | None, dict[str, Any] | None]
    # (text, mimeType, _meta) of the first content item of resources/read
```

### I5. `tools/views.py` (owner S4; extended by S7)

```python
@dataclass(frozen=True)
class ViewApps:
    browser: AppConfig        # AppConfig(resource_uri=view_uri("browser"))
    review: AppConfig         # AppConfig(resource_uri=view_uri("review"))

def view_apps() -> ViewApps: ...                                   # pure; no registration
def register(mcp: FastMCP, settings: Settings, members: MemberService) -> ViewApps: ...
```

`register` adds the `ui://` resources for every name in `VIEW_NAMES` and the `open_*` tools.
`server.py` calls it only when `settings.interactive_views` is true.

### I6. Review app on existing tools (owner S7)

```python
write.register(mcp, settings, members, snapshots, *, review_app: AppConfig | None = None)
history.register(mcp, settings, members, snapshots, *, review_app: AppConfig | None = None)
```

When `review_app` is not `None`, `update_page`, `replace_section`, `replace_page_json`
(write) and `diff_page` (history) are registered with `app=review_app`. Return dicts do not
change. When `None`, registration is byte-for-byte as today.

## Waves

| Wave | Slices |
|---|---|
| 1 | S1 apps core, S2 flag and harness, S3 ADR and security docs |
| 2 | S4 views module and `open_wiki`, S5 wiki browser view, S6 review view |
| 3 | S7 review app on write and history tools, S8 READMEs and changelog |

## S1. Apps package core: `build_view`, bridge, DOM helpers, CSS

- Goal: create `src/docmost_mcp_remote/apps/` with the assembler (I1), the hand-written MCP
  Apps bridge (I2), the safe DOM helpers (I3), the host-themed base CSS, and minimal shells
  for the `browser` and `review` views so that both build and pass the lint.
- Files:
  - create `src/docmost_mcp_remote/apps/__init__.py`
  - create `src/docmost_mcp_remote/apps/bridge.js`
  - create `src/docmost_mcp_remote/apps/dom.js`
  - create `src/docmost_mcp_remote/apps/base.css`
  - create `src/docmost_mcp_remote/apps/browser.html`, `browser.js` (shell: start the bridge, show "Loading" text; S5 replaces the script)
  - create `src/docmost_mcp_remote/apps/review.html`, `review.js` (shell; S6 replaces the script)
  - create `tests/test_apps.py`
- Interfaces: exposes I1, I2, I3. Consumes nothing new.
- Details:
  - HTML shell: `<!doctype html>`, `<meta charset="utf-8">`, viewport meta,
    `<meta name="color-scheme" content="light dark">`, one `<style>`, one `<script>`, a
    `<main id="app">`. No external URL anywhere.
  - `base.css`: `html, body { background: transparent }`; colours, fonts, radii only from
    host variables (source plan A.4) with `var(--x, <system fallback>)` and a
    `prefers-color-scheme: dark` fallback block; visible focus rings; works at 320 px.
  - bridge.js: JSON-RPC 2.0 over `window.parent.postMessage(msg, "*")` (the host sets the
    origin; the spec uses `*` for the view-to-host direction); request ids increment;
    pending map with a 30 s timeout. Apply `hostContext.theme` as
    `document.documentElement.dataset.theme` and each `styles.variables` entry with
    `style.setProperty`. Style of `web/upload.js`. About 200 lines.
  - `FORBIDDEN = ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(",
    "new Function", "http://", "https://")`. `lint_view` is a plain substring search over
    the assembled HTML.
- Depends on: none
- Wave: 1
- Model: opus
- Review tier: R2 (shared interfaces I1 to I3 and security code: the lint, `safeHref`, `unwrap`)
- Test targets: `uv run pytest tests/test_apps.py -q`
- Contract tests: `tests/test_apps.py`. It must test, for every name in `VIEW_NAMES`:
  `lint_view(build_view(name)) == []`; size `< MAX_VIEW_BYTES`; the HTML contains
  `window.mcpBridge`, `window.dom`, the base CSS, and no leftover `/*__` placeholder;
  `view_uri(name)` matches `^ui://docmost/<name>-[0-9a-f]{8}\.html$` and is stable across
  two calls; `build_view("nope")` raises `KeyError`; `lint_view` flags a string containing
  each needle. Node-backed (skip without `node`): load `dom.js` in a stub `window` and check
  `safeHref` (`https://a.b/` kept; `javascript:alert(1)`, `data:x`, `//x`, `vbscript:` give
  `null`), `unwrap` (envelope stripped, escaped closing tag restored, plain text unchanged),
  and `parseUnifiedDiff` on the output of `sections.unified_diff("a\nb\nc\n", "a\nB\nc\nd\n", limit=10_000)`
  (one hunk, kinds in order) and on a cut diff.
- Acceptance:
  - `uv run pytest tests/test_apps.py -q` passes (node tests run, not skipped, where `node` exists).
  - `uv run python -c "from docmost_mcp_remote.apps import build_view, view_uri; print(view_uri('browser'), len(build_view('review')))"` prints a `ui://docmost/browser-xxxxxxxx.html` URI and a length.
  - `uv build` then `unzip -l dist/*.whl | grep apps/` lists every `.js`, `.css` and `.html` file.
  - Lint and types pass.
- Out of scope: `tools/`, `server.py`, `config.py`, `tests/harness.py`, any docs. The real
  browser and review UI (S5, S6). No npm, no vendored SDK.

## S2. Feature flag and test harness helpers

- Goal: add the `INTERACTIVE_VIEWS` setting (default off) and the raw tool and resource
  helpers (I4) that later slices use to read `_meta` and MIME types.
- Files:
  - modify `src/docmost_mcp_remote/config.py` (add the field next to the other feature settings)
  - modify `.env.example` (commented `INTERACTIVE_VIEWS=false` with a one-line explanation)
  - modify `tests/harness.py` (add I4)
  - modify `tests/test_config.py` (flag tests)
- Interfaces: exposes `Settings.interactive_views: bool = Field(default=False, description=...)`
  and I4. `make_settings(interactive_views=True)` and
  `RunningServer(docmost, interactive_views=True)` work through existing `**overrides`.
- Details: I4 helpers follow the existing `_session(token, use)` pattern in
  `tests/harness.py`; `tool_entries` returns `client.list_tools()` unchanged;
  `read_resource` uses `client.read_resource(uri)` and returns `(item.text, item.mimeType,
  item.meta)` of the first item.
- Depends on: none
- Wave: 1
- Model: sonnet
- Review tier: R0 (config and test scaffolding, under 150 lines)
- Test targets: `uv run pytest tests/test_config.py -q`
- Contract tests: `tests/test_config.py` (default `False`; `INTERACTIVE_VIEWS=true` in the
  environment gives `True`).
- Acceptance:
  - `uv run pytest tests/test_config.py -q` passes.
  - `uv run python -c "from tests.conftest import make_settings; print(make_settings().interactive_views)"` prints `False`.
  - `grep -n INTERACTIVE_VIEWS .env.example` finds one line.
  - Lint and types pass.
- Out of scope: `INTERACTIVE_EDITING` and every Phase 3 setting; `server.py`; `apps/`;
  `tools/`; editing any existing test assertion.

## S3. ADR 0007, security model and design notes

- Goal: record the decision and the new trust boundary (the view iframe) before the code
  lands.
- Files:
  - create `docs/adr/0007-interactive-views-mcp-apps.md` (format of `docs/adr/0006-apache-2-license.md`)
  - modify `docs/security-model.md` (new trust boundary section)
  - modify `docs/DESIGN.md` (short "Interactive views" section)
- Interfaces: none
- Details: ADR content from source plan sections 1, 2 (Phases 1 and 2 rows), 3, 4.1 to 4.3
  and 6: MCP Apps extension, flag default off, hand-written bridge with the vendored
  ext-apps 1.7.5 contingency, no frontend tooling, no CDN, no external origins, resource
  URIs with a content hash, open risk ext-apps issue 671, "Refresh tools list" after deploy.
  State that Phase 3 is out of scope pending a separate decision. Security model: the seven
  rules of source plan 4.4 except rule 7 (Phase 3A), plus the constraint that the server
  cannot tell a view call from a model call and that `tools/confirm.py` lets a change
  through when the host cannot elicit, hence no destructive tool as a one-click button.
  English, plain style of the existing docs.
- Depends on: none
- Wave: 1
- Model: sonnet
- Review tier: R0 (docs)
- Test targets: none (docs only); run lint to confirm nothing else changed.
- Contract tests: none
- Acceptance:
  - `test -f docs/adr/0007-interactive-views-mcp-apps.md`
  - `grep -n "view iframe" docs/security-model.md` finds the new section.
  - `grep -n "INTERACTIVE_VIEWS" docs/adr/0007-interactive-views-mcp-apps.md docs/DESIGN.md` finds both.
  - `git diff --stat` shows only the three files.
- Out of scope: README files and `CHANGELOG.md` (S8); any code; Phase 3 design (ADR 0008 and 0009).

## S4. Views module, `ui://` resources, `open_wiki`, server wiring

- Goal: add `tools/views.py` (I5) with the `ui://` resources and the `open_wiki` tool, and
  call it from `server.py` only when the flag is on.
- Files:
  - create `src/docmost_mcp_remote/tools/views.py`
  - modify `src/docmost_mcp_remote/server.py` (call `views.register(mcp, settings, members)` after `resources.register(...)` when `settings.interactive_views`; append one sentence to the instructions only then)
  - create `tests/test_view_tools.py`
- Interfaces: exposes I5. Consumes I1 (`build_view`, `view_uri`, `VIEW_NAMES`), I4,
  `Settings.interactive_views`.
- Details:
  - Resources: for each name, `@mcp.resource(view_uri(name), name=f"{name}_view",
    mime_type=UI_MIME_TYPE, app=AppConfig(prefers_border=False), auth=require_scopes("read"))`
    returning `build_view(name)`. No `csp`, `domain` or `permissions`. No member data.
  - `open_wiki(space_id: str | None = None, page: str | None = None, query: str | None = None)`:
    title "Docmost wiki", read-only annotations, `auth=require_scopes("read")`,
    `app=apps.browser`, `meta={"openai/ui": {"entrypoints": [{"type": "global"}]}}`. Useful
    with `{}`. Returns `{"notice": NOTICE, "spaces": [{"id", "slug", "name"} for allowed
    spaces], "selected": {...}}` where `selected` holds `space_id`, the page summary
    (`id`, `slug_id`, `title`, `url` via `page_link`, `space_id`) when `page` is given, and
    `query` when given. Space and page access go through `SpacePolicy` exactly as
    `list_spaces` and `get_page` do. Description says it opens an interactive wiki browser
    and that text-only clients get the same list.
  - If `meta=` and `app=` do not merge into one `_meta` on the tool, build the dict by hand
    with `app_config_to_meta_dict` and pass only `meta=`.
  - `INSTRUCTIONS`: keep the constant unchanged; when the flag is on pass
    `INSTRUCTIONS + " " + VIEWS_SENTENCE` (sentence: `open_wiki` opens an interactive browser
    where the client supports it; content in views is the same untrusted data).
- Depends on: S1, S2
- Wave: 2
- Model: opus
- Review tier: R2 (shared interface I5 consumed by S7; server wiring and auth scope on new resources)
- Test targets: `uv run pytest tests/test_view_tools.py tests/test_read_tools.py tests/test_resources_prompts.py tests/test_server.py -q`
- Contract tests: `tests/test_view_tools.py`. It must cover: flag off: no `ui://` resource,
  no `open_wiki`, no tool `_meta` contains `ui`; flag on: tool list equals the flag-off list
  plus `open_wiki` (read token); resource list adds exactly the two `ui://` URIs;
  `read_resource` gives MIME `text/html;profile=mcp-app`, `_meta.ui.prefersBorder is False`,
  no `csp`/`domain`, text equal to `build_view(name)`; `open_wiki` `_meta` has
  `ui.resourceUri == view_uri("browser")` and `openai/ui.entrypoints == [{"type": "global"}]`;
  a token without `read` does not see `open_wiki` or the resources; `open_wiki` with `{}`
  returns `notice` and `spaces`; with `allowed_spaces` set, other spaces are absent and a page
  in them is refused; instructions contain the views sentence only with the flag on.
- Acceptance:
  - Targeted tests pass with `DATABASE_TEST_URL` set (report skips otherwise).
  - `tests/test_read_tools.py::test_tool_list` and `tests/test_resources_prompts.py::test_resources_are_listed` pass unedited.
  - Lint and types pass.
- Out of scope: `tools/write.py`, `tools/history.py`, `open_page_history` and the review
  wiring (S7); `apps/*` (S1, S5, S6); README and docs.

## S5. Wiki browser view

- Goal: implement the read-only wiki browser in `apps/browser.js` (and its layout in
  `apps/browser.html`) as specified in source plan Phase 1, "Browser".
- Files:
  - modify `src/docmost_mcp_remote/apps/browser.html`
  - modify `src/docmost_mcp_remote/apps/browser.js`
  - create `tests/test_browser_view.py`
- Interfaces: consumes I2 and I3 only. Calls through `mcpBridge.callTool` the existing
  tools `list_spaces`, `list_pages` (flat, with `has_children`, lazy tree), `search`,
  `suggest`, `get_page` with `format="json"`. Reads its initial state from the `open_wiki`
  tool result (`spaces`, `selected`). Read each tool's argument names and result fields from
  its definition in `tools/read.py` and `tools/navigate.py`.
- Details:
  - Layout: `inline` shows search box and result list only; `fullscreen` shows tree, search
    and preview. Switch on `hostContext.displayMode` and `containerDimensions`. "Open in
    panel" calls `mcpBridge.requestMode("fullscreen")` inside the click handler.
  - Preview renders ProseMirror JSON with an allowlist: paragraph, heading, bulletList,
    orderedList, listItem, taskList, taskItem, table, tableRow, tableCell, tableHeader,
    codeBlock, blockquote, callout, horizontalRule, text, hardBreak; marks bold, italic, code,
    strike, link. Unknown node: plain text of its children. Images: a placeholder with the
    file name. Links: `dom.safeHref`, clicked through `mcpBridge.openLink`.
  - Buttons: "Open in Docmost" (`openLink(page.url)`), "Ask Claude about this page"
    (`sendMessage` with a fixed English template plus the page id only).
  - On selection: `updateContext({page_id, space_id})`, nothing else.
  - States: loading, empty, error (tool error text shown via `textContent`), `truncated`,
    `next_cursor` ("Load more"). Keyboard: arrow keys in lists and tree, Enter opens,
    visible focus. Works at 320 px. Titles and snippets pass through `dom.unwrap` before display.
- Depends on: S1
- Wave: 2
- Model: opus
- Review tier: R2 (renders untrusted wiki content and links; likely over 400 lines)
- Test targets: `uv run pytest tests/test_browser_view.py tests/test_apps.py -q`
- Contract tests: must keep `tests/test_apps.py` passing.
- Acceptance:
  - Both test files pass. `tests/test_browser_view.py` checks on `build_view("browser")`:
    no name from `FORBIDDEN`; it calls each of the five tool names; it contains the
    allowlisted node names; it never passes a variable other than a page id or space id to
    `updateContext` (static check on the call sites is enough); size under `MAX_VIEW_BYTES`.
  - Node-backed test (skip without `node`): run the preview renderer from `browser.js` in a
    minimal DOM stub on a fixture with `<img onerror=...>` text, a `javascript:` link and an
    envelope break-out attempt; assert no element other than allowlisted tags is created and
    the link has no `href` or a `null` one. If a DOM stub is impractical, state so in the
    report and keep the static checks.
  - Lint and types pass.
- Out of scope: `bridge.js`, `dom.js`, `base.css`, `apps/__init__.py` (report needed changes
  instead); any Python under `src/`; any write tool call.

## S6. Change-review view (with version-history mode)

- Goal: implement `apps/review.js` and `apps/review.html` as specified in source plan
  Phase 2: diff review for dry-run and saved results, and a version list mode used by
  `open_page_history`.
- Files:
  - modify `src/docmost_mcp_remote/apps/review.html`
  - modify `src/docmost_mcp_remote/apps/review.js`
  - create `tests/test_review_view.py`
- Interfaces: consumes I2 and I3. Input is the tool result of one of `update_page`,
  `replace_section`, `replace_page_json`, `diff_page` or `open_page_history`. Read the result
  fields from `preview()` and `result()` in `tools/write.py` (`dry_run`, `diff`,
  `diff_truncated`, `formatting_removed`, `hint`, `problems`, `snapshot_id`, `id`, `title`,
  `url`) and from `diff_page` and `list_page_history` in `tools/history.py`. The
  `open_page_history` result (from S7) is `{"notice", "page": {id, slug_id, title, url,
  space_id}, "history": <list_page_history result>}`; detect it by the `history` key.
- Details:
  - Dry run or `diff_page`: `dom.unwrap` the diff, `dom.parseUnifiedDiff`, render hunks with
    add, delete and context lines as text; show `diff_truncated`, `formatting_removed` and
    `problems` notices.
  - Saved (not a dry run): compact card with title, "Open in Docmost" link and `snapshot_id`.
  - Buttons send fixed English templates with `mcpBridge.sendMessage` plus ids only:
    "Apply this change", "Discard", and for `diff_page` "Restore this version". The view
    calls no write tool.
  - History mode: version list (from the result, then "Load more" through
    `callTool("list_page_history", ...)`); selecting a version calls
    `callTool("diff_page", ...)` and renders the diff as above.
  - Inline-friendly: at most two primary actions, no nested scroll in `inline`. 320 px.
- Depends on: S1
- Wave: 2
- Model: opus
- Review tier: R1 (isolated UI on top of the linted helpers; renders only diff text)
- Test targets: `uv run pytest tests/test_review_view.py tests/test_apps.py -q`
- Contract tests: must keep `tests/test_apps.py` passing.
- Acceptance:
  - Both test files pass. `tests/test_review_view.py` checks on `build_view("review")`: lint
    clean; the only tool names passed to `callTool` are `list_page_history` and `diff_page`;
    no write tool name (`update_page`, `replace_section`, `replace_page_json`,
    `restore_page_version`, `restore_snapshot`, `trash_page`, `move_page`) appears as a
    `callTool` argument; the three button labels are present; size under `MAX_VIEW_BYTES`.
  - Lint and types pass.
- Out of scope: `bridge.js`, `dom.js`, `base.css`, `apps/__init__.py`; any Python under `src/`.

## S7. Review app on write and history tools, and `open_page_history`

- Goal: when the flag is on, attach the review view to `diff_page`, `update_page`,
  `replace_section` and `replace_page_json` (I6), and add the model-visible
  `open_page_history(page)` tool.
- Files:
  - modify `src/docmost_mcp_remote/tools/write.py` (keyword-only `review_app` on `register`; `app=review_app` on the three tools)
  - modify `src/docmost_mcp_remote/tools/history.py` (same for `diff_page`)
  - modify `src/docmost_mcp_remote/tools/views.py` (add `open_page_history`)
  - modify `src/docmost_mcp_remote/server.py` (when the flag is on, compute `apps = views.view_apps()` before `write.register`, pass `review_app=apps.review` to `write.register` and `history.register`; flag off passes nothing)
  - modify `tests/test_view_tools.py`
- Interfaces: exposes I6. Consumes I5.
- Details:
  - Pass `app=` only when `review_app is not None` (for example
    `**({"app": review_app} if review_app else {})`) so flag-off registration is unchanged.
  - The return dicts of the four tools do not change. `check_not_busy`, snapshots,
    `tools/confirm.py` flows and annotations stay as they are.
  - `open_page_history(page)`: scope `read`, read-only annotations, `app=apps.review`.
    Returns `{"notice": NOTICE, "page": {id, slug_id, title, url, space_id},
    "history": <the same dict list_page_history returns for that page>}`. Reuse the
    history listing logic; do not duplicate the Docmost calls. `SpacePolicy` applies.
- Depends on: S4, S6
- Wave: 3
- Model: opus
- Review tier: R2 (touches `tools/write.py`, which `CONTRIBUTING.md` puts under extra review; shared interface I6)
- Test targets: `uv run pytest tests/test_view_tools.py tests/test_write_tools.py tests/test_history_tools.py tests/test_read_tools.py tests/test_server.py -q`
- Contract tests: `tests/test_view_tools.py` (extended) and S4's contract tests still pass.
  New cases: flag on: the four tools carry `_meta.ui.resourceUri == view_uri("review")`;
  their dry-run and saved results equal the flag-off results for the same mock calls;
  `open_page_history` is listed for a read token and returns `page` and `history`; a page in
  a disallowed space is refused. Flag off: none of the four tools has `_meta.ui`.
- Acceptance:
  - Targeted tests pass with `DATABASE_TEST_URL` set (report skips otherwise).
  - `git diff -U0 src/docmost_mcp_remote/tools/write.py src/docmost_mcp_remote/tools/history.py` shows only the `register` signatures and the `app=` additions.
  - Lint and types pass.
- Out of scope: `base_hash`, `document_hash`, `page_status`, `open_page` and anything else from
  Phase 3; `apps/*`; README and docs.

## S8. READMEs and changelog

- Goal: document the interactive views for users in both languages and add the
  `[Unreleased]` entry.
- Files:
  - modify `README.md`
  - modify `README.ru.md`
  - modify `CHANGELOG.md`
- Interfaces: none. Facts to document: flag `INTERACTIVE_VIEWS` (default `false`); new tools
  `open_wiki` (opens the wiki browser; optional `space_id`, `page`, `query`) and
  `open_page_history(page)` (version list with diffs), both scope `read`, only listed when the
  flag is on; the review view appears on `diff_page`, `update_page`, `replace_section`,
  `replace_page_json` results; views are read-only and every write still goes through Claude
  and its approval prompt; client notes (MCP Apps hosts such as Claude; others get the same
  text results; "Refresh tools list" after a deploy; entry point and side panel have limited
  availability); link to ADR 0007 and `docs/security-model.md`.
- Details: add an "Interactive views" section; add the two tool rows to the tool tables with a
  note that they need the flag; keep "62 tools" and add "(64 with `INTERACTIVE_VIEWS`)" where
  the count appears (`README.md` lines 49 and 363, `README.ru.md` lines 47 and 361);
  `README.ru.md` mirrors `README.md` section for section.
- Depends on: S4 (tool names and signatures as merged; read them from `tools/views.py` on the
  merged branch and correct the facts above if they differ)
- Wave: 3
- Model: sonnet
- Review tier: R0 (docs)
- Test targets: `uv run pytest tests/test_release_metadata.py -q`
- Contract tests: none
- Acceptance:
  - `grep -c "INTERACTIVE_VIEWS" README.md README.ru.md` is at least 1 for each.
  - `grep -n "open_wiki" README.md README.ru.md CHANGELOG.md` finds all three.
  - `tests/test_release_metadata.py` passes.
- Out of scope: `docs/` (S3); any code; version bump or release.

## Integration notes

Cross-slice touchpoints and what the integrator checks at each:

1. `src/docmost_mcp_remote/apps/` (S1, then S5 and S6). S5 and S6 replace the S1 shells for
   their own view only. Check that `bridge.js`, `dom.js`, `base.css` and `__init__.py` are
   unchanged after wave 2, that both views still pass `tests/test_apps.py`, and that each
   view's size is under 200 KB.
2. `src/docmost_mcp_remote/server.py` (S4, then S7). S4 adds `views.register` after
   `resources.register` behind the flag and the conditional instructions sentence. S7 moves
   the computation of `view_apps()` before `write.register` and passes `review_app`. Check
   that the flag-off path calls neither, that `views.register` is still called exactly once,
   and that `view_apps()` and `register` give the same URIs.
3. `src/docmost_mcp_remote/tools/views.py` (S4, then S7) and `tests/test_view_tools.py`
   (S4, then S7). S7 adds `open_page_history`; the flag-on expected tool list in S4's tests
   must gain it in the same change.
4. Tool and resource lists. `tests/test_read_tools.py::test_tool_list` and
   `tests/test_resources_prompts.py::test_resources_are_listed` must pass unedited (flag off).
   The flag-on lists live only in `tests/test_view_tools.py`.
5. `tools/write.py` and `tools/history.py` (S7 only). Confirm return dicts are unchanged and
   that registration without `review_app` produces the same `list_tools()` entries as before
   the change (compare against the flag-off list and `_meta`).
6. Bridge contract I2 and DOM contract I3 (S1, consumed by S5 and S6). If a view slice
   reported a needed change to `bridge.js` or `dom.js`, the integrator makes it in one place
   and re-runs `tests/test_apps.py`, `tests/test_browser_view.py`, `tests/test_review_view.py`.
7. Config: `Settings.interactive_views` (S2), `.env.example` (S2), documented in S3 and S8.
   Check the name and default match in all four places.
8. Packaging: `uv build` and confirm the wheel contains `apps/*.js`, `*.css`, `*.html`; the
   Dockerfile installs from the wheel, so the assets reach the image. Run `docker build` if
   Docker is available; otherwise record it as not run.
9. Database: server-backed tests need `DATABASE_TEST_URL` (Postgres 17). The final full suite
   must run with it set; a run where these tests skip does not count as integration passed.
10. Manual verification from source plan section 8, steps 3 to 5 (fake-host Playwright
    hostile-content check, ext-apps reference host, real Claude host) is not automated here.
    The integrator runs step 3 only if Playwright and Chromium are available and records the
    outcome in the Integrator log; steps 4 and 5 are for the maintainer after deploy.
11. Phase 3 stays out: no `INTERACTIVE_EDITING`, `EMBED_SHARED_SECRET`, `page.*`, `vendor/`,
    `frontend/`, `base_hash`, `document_hash`, `page_status`, `editor_session` anywhere in the
    diff.
