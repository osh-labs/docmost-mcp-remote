## Multi-agent workflow

<!-- multi-agent-workflow policy v1.2. Source: SEM Dev > Claude Multi-Agent Workflow. Update this copy when the source changes. -->

This repo uses a plan -> orchestrate -> slice -> integrate workflow.

- Planner (Opus or Fable): writes PLAN.md and the PROGRESS.md skeleton. Writes no code.
- Orchestrator (Sonnet, medium effort): runs the implement-plan skill. Dispatches, merges clean merges, runs targeted and contract tests, and updates PROGRESS.md. Never reads or edits source code.
- Integrator (Opus, medium effort): called by the orchestrator, fresh each time, for merge conflicts, cross-slice test failures, contract-test failures, and final integration.
- Slice agents (Opus, medium effort, by default; Sonnet, medium effort, for mechanical slices): implement one slice each, in their own worktree and branch. Haiku is not used for slices.

### Project commands

Fill these in per repo. All agents use these exact commands.

- Targeted tests: `uv run pytest {test paths} -q`
- Full suite: `uv run pytest` (integration tests in `tests/integration` need the Docker compose stack from CI; confirm before relying on them)
- Lint and types: `uv run ruff format --check . && uv run ruff check . && uv run mypy` (matches CI)
- Source-to-test mapping: `src/docmost_mcp_remote/<module>.py -> tests/test_<module>.py` (tools under `src/docmost_mcp_remote/tools/` map to `tests/test_*_tools.py`; mapping is approximate, verify per slice)

### Testing policy (all agents)

1. Slice agents run targeted tests only for the files they changed, once, after their final change. On failure, fix and run again. After 3 failed runs, stop and report the slice as blocked with the failing test names.
2. Do not run tests after intermediate edits. Do not re-run a passing test on unchanged code.
3. Only the integrator runs the full suite, and only during final integration: once, plus at most one re-run after fixes, with the `FULL_SUITE_OK=1` prefix. A hook blocks other full-suite runs.
4. A suspected flaky test may be re-run once. If it then passes, record it under Flaky in PROGRESS.md and move on.
5. Pipe test output through `2>&1 | tail -n 40`. Report results in 10 lines or fewer: pass and fail counts, and failing test names. Never paste full logs into reports or PROGRESS.md.
6. After each merge, the orchestrator runs targeted tests for the merge diff once and records the SHA and result in PROGRESS.md. Skip any run whose SHA already has a recorded pass.
7. At the end of a wave that included a slice exposing a shared interface, the orchestrator runs that slice's contract tests once. Failures go to the integrator. No full suite at wave boundaries.

### Review tiers

The planner assigns one tier per slice. Slice agents never change a tier. The orchestrator may raise a tier only when a trigger below applies, and must state which one.

- R0: tests and lint only. Default for docs, config, isolated UI, and diffs under 150 lines.
- R1: one Sonnet reviewer, read-only, report of 300 words or fewer against the slice's acceptance criteria.
- R2: deep review on Opus. Only for changes to shared interfaces or contracts, security or data-integrity code, diffs over 400 lines, or an R1 that found a blocking issue.
- R2 on Fable: only with the user's explicit approval, for unusual complexity or risk. The planner may request it in the slice (`R2-fable: <reason>`); the orchestrator asks the user before running it, uses Opus if not approved, and records the decision in PROGRESS.md.

### PROGRESS.md

- Lives next to the plan file. It and git are the record of run state; conversation history is not.
- Only the orchestrator edits it. Slice agents never touch it.
- Update and commit it after every slice state change, message `progress: <slice> <status>`, and push with the merge.
- Status values: todo, dispatched, merged, verified, blocked.
- Change requests that arrive mid-run go under Deferred, not to a running agent, unless the user says otherwise.
- On resume, rebuild state from PROGRESS.md and `git log` only. Do not re-read old transcripts or re-explore the codebase. If PROGRESS.md and git disagree, git wins.

### Plan format (planner)

Write the plan to `docs/plans/<plan-name>/PLAN.md` and a PROGRESS.md skeleton beside it. Put the branch name and plan path in the commit message. Each slice has:

- ID and title (S1, S2, ...)
- Goal: one or two sentences
- Files: exact paths to create or modify
- Interfaces: signatures or contracts the slice exposes or consumes
- Depends on: slice IDs, or none
- Wave: slices in the same wave are independent and can run in parallel
- Model: opus (default) or sonnet (mechanical: renames, boilerplate, config, docs, test scaffolding from a given spec). Both run at medium effort. No haiku.
- Review tier: R0, R1, R2, or R2-fable with a one-line reason
- Test targets: the test files or command the slice must pass
- Contract tests: for a slice that exposes a shared interface, the test file that later slices must also pass
- Acceptance: runnable commands and observable results, not prose
- Out of scope: what the slice must not touch

Each slice must be self-contained: an agent that reads only its slice and this file can finish it without exploring the codebase. Waves hold at most 3 slices by default.

Integration rules for the planner:
- Slices in the same wave must not list any of the same files. If two slices must touch one file, put them in different waves.
- Shared-interface slices go in the earliest wave and ship their contract tests with them.
- End the plan with an Integration notes section: the cross-slice touchpoints (shared files, registries, routes, config, migrations) and what the integrator should check at each.
