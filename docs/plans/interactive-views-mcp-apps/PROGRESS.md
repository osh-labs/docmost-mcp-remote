# Progress: interactive views (MCP Apps), Phases 1 and 2

Plan: `docs/plans/interactive-views-mcp-apps/PLAN.md`
Source plan: `docs/plans/interactive-views-mcp-apps.md`
Branch: `claude/laughing-gauss-gxcpu9`
Max parallel: 3

Only the orchestrator edits this file. Status values: todo, dispatched, merged, verified, blocked.

## Slices

| ID | Title | Wave | Depends on | Model | Review tier | Status | Branch | Merge SHA | Tested SHA | Tests |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Apps package core: build_view, bridge, DOM helpers, CSS | 1 | none | opus | R2 | verified | claude/laughing-gauss-gxcpu9--S1 | 7c83f2e | 7c83f2e | tests/test_apps.py -> 18 passed; R2 (Opus): pass, no blocking |
| S2 | Feature flag and test harness helpers | 1 | none | sonnet | R0 | merged | claude/laughing-gauss-gxcpu9--S2 | 1d00c1a | 1d00c1a | tests/test_config.py -> 18 passed |
| S3 | ADR 0007, security model and design notes | 1 | none | sonnet | R0 | merged | claude/laughing-gauss-gxcpu9--S3 | 75117cb | 75117cb | docs only; ruff format --check: 1 file unformatted (PLAN.md code block, pre-existing, not S3) |
| S4 | Views module, ui:// resources, open_wiki, server wiring | 2 | S1, S2 | opus | R2 | todo | | | | |
| S5 | Wiki browser view | 2 | S1 | opus | R2 | todo | | | | |
| S6 | Change-review view (with version-history mode) | 2 | S1 | opus | R1 | todo | | | | |
| S7 | Review app on write and history tools, open_page_history | 3 | S4, S6 | opus | R2 | todo | | | | |
| S8 | READMEs and changelog | 3 | S4 | sonnet | R0 | todo | | | | |

## Current wave

Wave 1 in progress: Wave 1 complete (S1 verified, S2, S3 merged); wave 2 (S4, S5, S6) dispatched.

## Next step

Merge wave 2 slices as they report (S4 R2, S5 R2, S6 R1), then run S1 and S4 contract tests, then dispatch wave 3 (S7, S8).

## Blocked

None.

## Deferred

- S1 R2 non-blocking nits, for the integrator or a follow-up (priority 1 and 6 before the PR): (1) `dom.js:38` `el` accepts any tag, e.g. script/iframe/object/embed/style/link/meta; refuse them. (2) `__init__.py:68` lint is a case-sensitive substring search; note the limit in the security doc. (3) `dom.js:86` truncated hunk adds an extra empty context line. (4) `dom.js:9` `unwrap` restores only the lowercase escape. (5) `bridge.js:73` host style variables applied unchecked. (6) `bridge.js` `hostContext()` returns the internal object; copy or freeze. (7) `safeHref` keeps `user:pass@`. (8) no tests for bridge message checks or `el` attribute rejection.
- Integrator: `ruff format --check .` flags a Python code block in `docs/plans/interactive-views-mcp-apps/PLAN.md` (line 60, from the planner commit 19e9ab7). Plain `ruff format .` rewrites that file (S2 agent saw this and reverted it); slices must not commit it. Fix or exclude before the PR so CI passes.
- Phase 3: awaiting user go decision.

## Decisions

- 2026-11-22 (orchestrator): `DATABASE_TEST_URL` is unset in this container; Postgres 16 is installed but not running and the Docker daemon is not reachable (Postgres 17 is required). Server-backed tests skip here. Wave 2 proceeds; server-backed coverage for S4 and S7 must be confirmed in CI or the final integration run.
- 2026-11-22 (orchestrator): slice-implementer, slice-integrator and slice-reviewer agent types were unavailable; slices run as general-purpose agents with the plan's model per slice.
- 2026-11-22 (planner): `fastmcp.apps` is present in the locked FastMCP 4.1.3; no dependency bump planned.
- 2026-11-22 (planner): flag-on tool and resource lists are asserted only in `tests/test_view_tools.py`; the existing flag-off exact-list tests stay unedited.
- 2026-11-22 (planner): no slice tagged R2-fable.

## Flaky

None.

## Integrator log

None.

## Integration checklist

- [ ] `apps/` shared files (`bridge.js`, `dom.js`, `base.css`, `__init__.py`) unchanged by S5 and S6; all views lint-clean and under 200 KB
- [ ] `server.py`: flag-off path calls neither `views.register` nor `view_apps`; `views.register` called once; `review_app` passed to write and history (S4, S7)
- [ ] `tools/views.py` and `tests/test_view_tools.py`: flag-on list includes `open_wiki` and `open_page_history`
- [ ] `tests/test_read_tools.py::test_tool_list` and `tests/test_resources_prompts.py::test_resources_are_listed` pass unedited
- [ ] `tools/write.py`, `tools/history.py`: return dicts and flag-off `list_tools()` entries unchanged
- [ ] Bridge (I2) and DOM (I3) change requests from S5 and S6 resolved in one place
- [ ] `INTERACTIVE_VIEWS` name and default match in `config.py`, `.env.example`, ADR 0007, READMEs
- [ ] `uv build` wheel contains `apps/*.js`, `*.css`, `*.html`; `docker build` run or recorded as not run
- [ ] Full suite run with `DATABASE_TEST_URL` set (`FULL_SUITE_OK=1`)
- [ ] Source plan section 8 step 3 (fake-host Playwright) run or recorded as not run
- [ ] No Phase 3 names in the diff (`INTERACTIVE_EDITING`, `EMBED_SHARED_SECRET`, `page.*`, `vendor/`, `frontend/`, `base_hash`, `document_hash`, `page_status`, `editor_session`)
- [ ] Lint and types: `uv run ruff format --check . && uv run ruff check . && uv run mypy`
