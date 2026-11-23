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
| S4 | Views module, ui:// resources, open_wiki, server wiring | 2 | S1, S2 | opus | R2 | verified | claude/laughing-gauss-gxcpu9--S4 | 4862385 | 4862385 | 4 passed, 30 skipped (8 of 10 contract tests in test_view_tools.py need DATABASE_TEST_URL, not yet run); R2 (Opus): pass, no blocking |
| S5 | Wiki browser view | 2 | S1 | opus | R2 | verified | claude/laughing-gauss-gxcpu9--S5 | 3b151b3 | 3b151b3 | test_browser_view.py + test_apps.py -> 28 passed after fix 1c5e38d; R2 re-review (Opus): pass |
| S6 | Change-review view (with version-history mode) | 2 | S1 | opus | R1 | verified | claude/laughing-gauss-gxcpu9--S6 | 4f96314 | 4f96314 | test_review_view.py + test_apps.py -> 29 passed; R1 (Sonnet): pass, no blocking |
| S7 | Review app on write and history tools, open_page_history | 3 | S4, S6 | opus | R2 | verified | claude/laughing-gauss-gxcpu9--S7 | 7fae5b8 | 7fae5b8 | 3 passed, 69 skipped (all S7 tests are server-backed; none ran, need DATABASE_TEST_URL); R2 (Opus): pass, no blocking; README signature and counts check pass |
| S8 | READMEs and changelog | 3 | S4 | sonnet | R0 | merged | claude/laughing-gauss-gxcpu9--S8 | 09f93e8 | 09f93e8 | tests/test_release_metadata.py -> 5 passed |

## Current wave

Wave 1 in progress: Wave 2 complete (S4, S6 verified; S5 merged, R2 review running). All slices merged; final integration done at 1d32d17. Wave 2 contract tests (S1 test_apps.py, S4 test_view_tools.py) at 5e2c8d7: 20 passed, 8 skipped (need DATABASE_TEST_URL).

## Next step

Run CI with Postgres 17 so the skipped server-backed tests (S4, S7, no-read refusal asserts) execute; Playwright fake-host and docker build still not run. Decide the safeHref `http:` question (I3). PR #5 is open; CI there is the first real run of the server-backed tests.

## Blocked

None. (S5 R2 blocker fixed in 1c5e38d and merged at 3b151b3; re-review of the fix running.)

## Deferred

- S7 R2 non-blocking nits: `open_page_history` fetches the page twice and returns the first 20 versions with no cursor or limit; `view_apps()` is built twice (server.py and views.register). Latency/cosmetic only; no action planned.
- S5 R2 re-review nit: if the user picks a page or types a query during the 1.5 s fallback window, a late `open_wiki` result replaces both and calls `updateContext` a second time (ids only, no security effect). Skip `selected` and `query` when the user already chose something.
- S8 check after S7 merges: README `open_page_history` signature and tool counts (S8 wrote them from the plan; S7 had not merged). Also S5 R2 nit: `safeHref`/`openLink` accept `http:` per I3 (S5 reviewer expected https only); decide whether I3 should tighten.
- S4 R2 non-blocking nits: (1) `views.py:110` `space_id` not checked for existence when ALLOWED_SPACES is unset. (2) `views.py:110-123` `selected.space_id` can mismatch the page's space. (3) with ALLOWED_SPACES set, spaces may be listed up to 3 times per call; reuse `allowed_ids`. (4) `test_token_without_read_sees_no_views` does not assert a direct `read_resource` or `call` is refused.
- S1 R2 non-blocking nits, for the integrator or a follow-up (priority 1 and 6 before the PR): (1) `dom.js:38` `el` accepts any tag, e.g. script/iframe/object/embed/style/link/meta; refuse them. (2) `__init__.py:68` lint is a case-sensitive substring search; note the limit in the security doc. (3) `dom.js:86` truncated hunk adds an extra empty context line. (4) `dom.js:9` `unwrap` restores only the lowercase escape. (5) `bridge.js:73` host style variables applied unchecked. (6) `bridge.js` `hostContext()` returns the internal object; copy or freeze. (7) `safeHref` keeps `user:pass@`. (8) no tests for bridge message checks or `el` attribute rejection.
- Integrator: `ruff format --check .` flags a Python code block in `docs/plans/interactive-views-mcp-apps/PLAN.md` (line 60, from the planner commit 19e9ab7). Plain `ruff format .` rewrites that file (S2 agent saw this and reverted it); slices must not commit it. Fix or exclude before the PR so CI passes.
- Phase 3: awaiting user go decision.

## Decisions

- 2026-11-23 (orchestrator): PR #5 (https://github.com/osh-labs/docmost-mcp-remote/pull/5) was created from the Claude Code UI; further pushes to this branch update it.
- 2026-11-22 (orchestrator): `DATABASE_TEST_URL` is unset in this container; Postgres 16 is installed but not running and the Docker daemon is not reachable (Postgres 17 is required). Server-backed tests skip here. Wave 2 proceeds; server-backed coverage for S4 and S7 must be confirmed in CI or the final integration run.
- 2026-11-22 (orchestrator): slice-implementer, slice-integrator and slice-reviewer agent types were unavailable; slices run as general-purpose agents with the plan's model per slice.
- 2026-11-22 (planner): `fastmcp.apps` is present in the locked FastMCP 4.1.3; no dependency bump planned.
- 2026-11-22 (planner): flag-on tool and resource lists are asserted only in `tests/test_view_tools.py`; the existing flag-off exact-list tests stay unedited.
- 2026-11-22 (planner): no slice tagged R2-fable.

## Flaky

None.

## Integrator log

- 2026-11-22 final (Opus, general-purpose): applied ruff exclude for docs/plans (7d0bb6a); `el` refuses script/iframe/object/embed/style/link/meta, `hostContext()` returns a copy, new bridge/el tests, no-read-token refusal asserts (1d32d17). Lint pass. Full suite once: 223 passed, 0 failed, 249 skipped (server-backed, `DATABASE_TEST_URL` unset). ROUTE: none.

## Integration checklist

- [x] `apps/` shared files (`bridge.js`, `dom.js`, `base.css`, `__init__.py`) unchanged by S5 and S6; all views lint-clean and under 200 KB
- [x] `server.py`: flag-off path calls neither `views.register` nor `view_apps`; `views.register` called once; `review_app` passed to write and history (S4, S7)
- [x] `tools/views.py` and `tests/test_view_tools.py`: flag-on list includes `open_wiki` and `open_page_history`
- [x] `tests/test_read_tools.py::test_tool_list` and `tests/test_resources_prompts.py::test_resources_are_listed` pass unedited
- [x] `tools/write.py`, `tools/history.py`: return dicts and flag-off `list_tools()` entries unchanged
- [x] Bridge (I2) and DOM (I3) change requests from S5 and S6 resolved in one place
- [x] `INTERACTIVE_VIEWS` name and default match in `config.py`, `.env.example`, ADR 0007, READMEs
- [x] `uv build` wheel contains `apps/*.js`, `*.css`, `*.html`; `docker build` run or recorded as not run
- [ ] Full suite run with `DATABASE_TEST_URL` set (`FULL_SUITE_OK=1`): NOT RUN here (no Postgres 17); ran without it, 223 passed, 249 skipped. Needs CI.
- [ ] Source plan section 8 step 3 (fake-host Playwright): NOT RUN (no Python playwright here)
- [x] No Phase 3 names in the diff (`INTERACTIVE_EDITING`, `EMBED_SHARED_SECRET`, `page.*`, `vendor/`, `frontend/`, `base_hash`, `document_hash`, `page_status`, `editor_session`)
- [x] Lint and types: `uv run ruff format --check . && uv run ruff check . && uv run mypy`
