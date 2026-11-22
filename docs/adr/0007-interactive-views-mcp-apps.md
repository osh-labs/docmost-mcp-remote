# 0007. Interactive views with MCP Apps

## Status
Accepted for Phases 1 and 2 (wiki browser, change review). Phase 3 (editing
alongside Claude) is out of scope here and waits for a separate go decision;
it would get its own ADRs.

## Context
Claude's interactive connectors use the MCP Apps extension
(`io.modelcontextprotocol/ui`). A tool declares `_meta.ui.resourceUri`, the
server serves a `ui://` HTML resource with MIME type
`text/html;profile=mcp-app`, and the host renders it in a sandboxed iframe that
talks to the host over postMessage JSON-RPC. This server is text-only today:
tools return dicts, there is no tool `_meta`, no `ui://` resource and no
frontend build tooling.

We want a wiki browser and a change-review view, read-only first.

Facts that shape the design:
- Claude shows no approval prompt when a view calls the connector's own tools.
  Tool `visibility` is a UX hint, not a security boundary: the server cannot
  tell a view call from a model call. `tools/confirm.py` lets a change through
  when the host cannot elicit.
- The default iframe CSP allows inline script and blocks all external origins.
- Docmost text reaches the client inside the `<docmost-untrusted-content>`
  envelope, with only the closing tag neutralised. It is not HTML-escaped.
- Side panel, entry points, app tools and embedded sites are limited to some
  organizations.
- Claude can cache a connector's tool list for up to about two hours.
- Open risk: ext-apps issue 671 (views not rendering in Claude; some reporters
  use FastMCP). Unresolved upstream.

## Decision
- Views are served through the MCP Apps extension, using `fastmcp.apps` from
  the locked FastMCP 4.1.3. No dependency bump.
- A feature flag, `INTERACTIVE_VIEWS`, defaults to off. With it off, the tool
  list, resource list and every tool's `_meta` are identical to 1.2.3.
- Views are read-only. They call only read tools. No destructive tool becomes
  a one-click button, because the server cannot tell a view call from a model
  call and `tools/confirm.py` lets changes through when the host cannot elicit.
- The bridge to the host is a small hand-written `bridge.js` (about 200 lines)
  that exposes a narrow API to the views; views never touch `postMessage`.
  Contingency, only if it fails in a real host: vendor
  `@modelcontextprotocol/ext-apps@1.7.5` (`dist/src/app-with-deps.js`, MIT)
  inline, pinned by SHA-256 and credited in `NOTICE`, behind the same API.
- No frontend tooling (no npm, no bundler) and no CDN. Each view is one
  self-contained HTML string with inline script and style.
- No external origins: views declare no `connectDomains`, `resourceDomains`
  or `frameDomains`.
- `ui://` resource URIs carry a content hash, so a changed view gets a new URI
  and hosts do not serve a stale cached copy.
- Security rules for views are recorded in `docs/security-model.md` (trust
  boundary "view iframe").
- Phases 1 and 2 are upstream-ready: flag off by default, no
  deployment-specific choices. Phase 3 is not decided here.

## Consequences
- After a deploy that changes tools or views, users must use Customize,
  Connectors, the connector's menu, "Refresh tools list" (or wait for the
  cache to expire).
- A new trust boundary exists: the view iframe renders untrusted wiki text.
  It is handled by DOM text APIs only and a pytest lint of the assembled views.
- Views work with `inline` and `fullscreen` display modes only; panel, entry
  points and app tools are progressive enhancement.
- If ext-apps issue 671 affects Claude, views may not render; the text tools
  keep working unchanged, and the flag can stay off.
- Phase 3 (editing in a view) stays out of scope until a separate decision.
