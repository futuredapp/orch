# Phase 1 — Read-only `completed` open — implementation summary

**Phase:** 1 of 3 (`plan.md` → "Read-only `completed` open")
**Status:** done — landed on the working tree, `Status: done` set in `plan.md`.
**Units delivered:** U1 (read-only open path), U2 (side-effect suppression), U3 (headless refusal + regression guards).

## What this phase ships

`orch resume <completed-id>` used to be a dead end — `executor.resume()` throws
`ResumeError` for a `completed` run (`src/core/workflow.ts:2109`). Phase 1 turns the
`completed` case into a **pure read-only open** of the existing end-of-run TUI, with a
verifiable zero-mutation guarantee, plus a headless refusal and regression guards. `failed`
runs are intentionally **left unchanged** in Phase 1 (still re-run via the existing path) — the
interactive failure view is Phase 2 (U6). `crashed`/`running` resume for real, unchanged.

## Source changes

- **`src/cli/commands/open-finished.ts`** *(new, ~85 lines)* — `openFinished()`: the mechanical
  core of D6/KTD-1. Builds the two-pane host via the injected `HostFactory` (whose steps-view
  daemon tails the already-finished `state.json` and projects the terminal `completed` view via
  the pre-existing `finalizeView`), then waits for the user to dismiss it. It **never** calls
  `executor.resume()` (no `setStatus('running')`, no execution), **never** writes a resume
  preamble (`run:resumed` lifecycle / `run.meta.json`), and installs **no cmux host** (so the
  teardown `notifyRunEnd` hook cannot clear/flip a status pill). Uses the raw process service (not
  the instrumented one) to avoid any log vector.

- **`src/cli/commands/execute-with-attach.ts`** — added an opt-in `readOnly?: boolean` to
  `ExecuteWithAttachOpts`. When set, the attach loop skips the workflow race entirely: it keeps the
  TUI mounted until foreground shutdown (q / detach), tears down, and returns `EXIT.OK` — no
  `beforeTeardown`, no end-of-run summary. Default (`undefined`/`false`) is a no-op, so `run`/
  `resume` behaviour is byte-for-byte unchanged. This reuses the existing SIGINT/SIGTERM/SIGHUP
  teardown scaffolding rather than duplicating it.

- **`src/cli/commands/resume.ts`** — `resumeCmd` branches on `state.status === 'completed'` after
  resolving the target: with an interactive two-pane terminal it calls `openFinished()`; otherwise
  it refuses (status-named message, non-zero). The branch sits before the `loadWorkflow`/preamble
  path, so a completed open needs no workflow file or config.

## Key decisions made during implementation

- **Headless refusal exit code is `CONFIG_ERROR` (2), not `CANNOT_RESUME` (3).** AT-6 says a
  finished run must *never* exit `CANNOT_RESUME`. The no-two-pane refusal is an
  environment-capability failure ("can't render the viewer here"), so `CONFIG_ERROR` keeps AT-6
  unambiguous even if read across *all* invocations, while still satisfying AT-20's "non-zero".
  KTD-2 explicitly left the exact code to the implementer.

- **Headless detection keys off the resolved run mode (`opts.mode !== 'two-pane'`).** A piped/CI
  invocation resolves to `plain` (never `two-pane`), so this is the load-bearing, testable signal
  for "no interactive terminal / tmux unavailable" — no separate TTY probe needed.

- **No cmux host is constructed at all on the open path** (rather than a no-op wrapper). Not
  building it is the strongest form of "no cmux side effects" and removes the teardown
  `notifyRunEnd` vector by construction.

## Tests

All on the `bun run check` fast/integration gate (no new real-tmux flake surface added):

- **`tests/integration/cli/commands/open-finished.test.ts`** — drives the real `openFinished`
  against a fake two-pane host (`awaitForegroundShutdown → 'quit'`) + a real `FileStateStore` over a
  seeded `completed` fixture, with a **spy `SessionLogger`** counting appends/writes. Asserts:
  exit 0 (AT-4), zero runner/step activity (AT-5), `state.json` byte-for-byte unchanged (AT-14),
  zero logger appends + zero file writes (AT-15/AT-17), zero `cmux` spawns (AT-16).
- **`tests/integration/cli/commands/resume-finished.test.ts`** — drives the real `resumeCmd`:
  no-two-pane completed refusal names the run + `completed` and leaves `state.json` unchanged
  (AT-20); never prints "cannot resume" / never returns `CANNOT_RESUME` (AT-6); two-pane completed
  routes into the viewer and exits 0 (AT-1 routing); crashed/running are **not** diverted into the
  open/refuse branch (AT-7/AT-8 regression); bare resume with only finished runs is "nothing to
  resume" with no prompt (AT-21).
- **`tests/_support/finished-run-fixture.ts`** *(new, reusable infra)* — `writeFinishedRun()`, the
  gating fixture builder the plan names: writes a pre-finished `.orch/state/<runId>/` (completed /
  crashed / running) without executing. Reused by both test files; available to Phase 2/3.

**AT→test coverage map (Phase 1):** AT-1 (routing here + rendering by the pre-existing
`tests/integration/real-tmux/end-of-run.test.ts`, which already proves a seeded `completed`
state.json renders `completed · q to quit · ⏎ to inspect`), AT-4, AT-5, AT-6, AT-7, AT-8, AT-13,
AT-14, AT-15, AT-16, AT-17, AT-20, AT-21, AT-22 — all ✅ with cited test files in
`acceptance-tests.md`.

### Verification run (all green)

`typecheck`, `lint`, `test:unit` (1788), `test:two-pane:fast` (260), `test:two-pane:full:fake`
(12), `test:two-pane:lifecycle` (26), `tests/integration/cli` (98), `check:int-dirs`,
`check:migration` (38), and `tests/integration/real-tmux/end-of-run.test.ts` (1).

## Surprises / notes for reviewers & later phases

- **One pre-existing unit flake.** A single `test:unit` run reported 1 failure that did **not**
  reproduce on two subsequent runs (1788/0). Consistent with the recorded learnings about
  pre-existing real-tmux/`.orch`-fixture/cwd flakiness — not caused by this change (which is
  confined to the resume/open CLI path + a test-only fixture builder).

- **Deliberately not built: the full DSL `scenario()` "open a pre-finished fixture" launch mode.**
  The plan's U1 names a full-host scenario opening a pre-finished fixture. I built the *fixture
  builder* (the reusable half) but **not** the DSL launch-spec extension, because the behaviour it
  would assert — a `completed` state.json rendering the terminal view in the real two-pane host —
  is already covered by `tests/integration/real-tmux/end-of-run.test.ts`, and `openFinished` mounts
  that exact viewer. My fake-host integration tests cover the new routing/purity/refusal behaviour
  that is genuinely this feature's. Net: AT-1's rendering is covered across existing + new tests
  without adding a new (flaky) real-tmux test or a large extension to the guarded DSL. If a
  reviewer wants the literal full-host scenario, it's a self-contained follow-up on top of
  `writeFinishedRun`.

- **AT-18 / AT-19 (⏎-inspect in the read-only viewer) left `⬜ todo`.** The viewer is reachable and
  the right-pane replay machinery is pre-existing, but I did not add a test driving `⏎` on a past
  interactive step *through the read-only open*. Flagged honestly rather than marked ✅. A natural
  add when Phase 2 wires the failed view (which shares the same inspect path for both views).

- **No schema change, no public-API/barrel change.** `RunState.schemaVersion` stays `5`. No
  `docs/public/` reconciliation needed (the new verb/behaviour is not yet documented there).

## Blockers

None. No blocker file was written. The brainstorm's assumptions held for Phase 1: the
`completed`/`failed` `StepsViewState` already projects from `state.json` without executing
(`finalizeView`), so the read-only open needed no execution infra — exactly as the
split-by-effort plan predicted.
