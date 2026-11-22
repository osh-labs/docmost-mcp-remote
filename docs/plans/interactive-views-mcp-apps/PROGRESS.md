# Progress: interactive views (MCP Apps), Phases 1 and 2

Plan: `docs/plans/interactive-views-mcp-apps/PLAN.md`
Source plan: `docs/plans/interactive-views-mcp-apps.md`
Branch: `claude/laughing-gauss-gxcpu9`
Max parallel: 3

Only the orchestrator edits this file. Status values: todo, dispatched, merged, verified, blocked.

## Slices

| ID | Title | Wave | Depends on | Model | Review tier | Status | Branch | Merge SHA | Tested SHA | Tests |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Apps package core: build_view, bridge, DOM helpers, CSS | 1 | none | opus | R2 | todo | | | | |
| S2 | Feature flag and test harness helpers | 1 | none | sonnet | R0 | todo | | | | |
| S3 | ADR 0007, security model and design notes | 1 | none | sonnet | R0 | todo | | | | |
| S4 | Views module, ui:// resources, open_wiki, server wiring | 2 | S1, S2 | opus | R2 | todo | | | | |
| S5 | Wiki browser view | 2 | S1 | opus | R2 | todo | | | | |
| S6 | Change-review view (with version-history mode) | 2 | S1 | opus | R1 | todo | | | | |
| S7 | Review app on write and history tools, open_page_history | 3 | S4, S6 | opus | R2 | todo | | | | |
| S8 | READMEs and changelog | 3 | S4 | sonnet | R0 | todo | | | | |

## Current wave

Wave 1 not started (S1, S2, S3).

## Next step

Confirm whether `DATABASE_TEST_URL` (Postgres 17) is available for server-backed tests, then dispatch wave 1: S1, S2, S3.

## Blocked

None.

## Deferred

- Phase 3: awaiting user go decision.

## Decisions

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
