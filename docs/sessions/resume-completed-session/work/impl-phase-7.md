# Phase 3 — `orch retry <id>` verb (U8) — implementation summary (round 7)

**Phase:** 3 of 3 (`plan.md` → "`orch retry <id>` verb")
**Status after this round:** Phase 3 **done**. With Phases 1 and 2 already `done`,
**every non-blocked phase of the plan is now implemented.**
**Gate:** `bun run check` green end-to-end (`EXIT=0`: lint → typecheck →
`test:project` incl. integration → `test:two-pane:lifecycle` → migration
overlap/import-parity/`_migration`). Docs gate `bun run docs:build` green. No
schema migration; no public-API barrel change.

## What this round ships — U8: the `orch retry <id>` verb

`orch retry <id>` is the non-interactive "fix it and finish" shorthand (D4):
`orch resume <id>` + immediate retry-and-continue, acting **only** on `failed`
runs. It is the last unit of the feature.

### `src/cli/commands/retry.ts` *(new)*

- **`retryCmd(deps, idArg, cliArgs, opts, hostFactory)`** — the `COMMANDS`-shaped
  entry. A missing id is a usage error (`orch retry` targets a specific run —
  unlike bare `orch resume`'s auto-discovery). Otherwise it resolves the id via
  `resolveExplicitTarget` (the prefix/not-found path now **exported** from
  `resume.ts`, so both verbs share one resolution), then delegates to `retryRun`.
- **`retryRun(args)`** — the status-gate + act core, split out so tests can drive
  it with an injected executor (`loaded`):
  - **Non-`failed`** (`completed`/`crashed`/`running`) → rejected with a
    status-named message and a non-zero exit (`EXIT.CANNOT_RESUME`). Per KTD-2 /
    open-Q1 I **reused `CANNOT_RESUME` and wrote the message inline** rather than
    adding a dedicated error type — the rejection is a direct CLI branch, not an
    executor throw, so no `errors.ts` change was needed. It never falls back to
    resume/read-only.
  - **`failed`** → drives auto retry-and-continue through the **host-free
    `runResumeExecution` seam** (the `[c]` continue core U6 pinned, KTD-5) with
    the U4 `defaultInstructionResolver` (D7). Exit code reflects the outcome
    (completed → 0; failed-again → non-zero).

### `src/cli/main.ts` — registration

Imported `retryCmd`, registered `retry: retryCmd` in `COMMANDS`, and added a
`retry <id> [prompt]` line to `HELP`.

### `src/cli/commands/resume.ts` — one export

`resolveExplicitTarget` and `ResolvedResumeTarget` are now `export`ed so `retry`
reuses `resume`'s exact prefix/not-found resolution (AT-R9) instead of
duplicating it. No behavior change to `resume`.

### Tests — `tests/integration/cli/commands/retry.test.ts` *(new, 10 tests)*

Drives the **real** `retryCmd`/`retryRun` over a real `FileStateStore` +
`FakeRunner` (the `failed` state produced by actually executing a three-step
workflow whose middle step fails — the same harness shape as `open-failed.test.ts`),
asserting the external boundary (exit code, stderr, on-disk `state.json`, runner
boundary, `ConfirmService` construction counter):

- **AT-R6** — `failed` → `retryRun` re-runs step2 and continues; `state.json`
  advances `failed → completed`, step3 ran, exit 0 — no keypress.
- **AT-R7** — `completed`/`crashed`/`running` each rejected (×3): status-named,
  non-zero, throwing host factory never reached (proves no open).
- **AT-R8** — headless (plain) `retryRun` runs the default to completion, exit 0;
  a separate fail-again case exits non-zero and leaves the run `failed`;
  `ConfirmService` recorded **zero** calls (the no-host/no-prompt guard).
- **AT-R9** — ambiguous prefix + not-found both exit non-zero with `resume`'s
  exact messages.
- Bare `orch retry` (no id) → usage error (no auto-discovery).
- **AT-R10 (cross-verb half)** — `retry`→`completed`, then a later `openFinished`
  read-only reopen loads cleanly, runner boundary untouched, still `completed`.

### Docs — `docs/public/reference/cli.md` reconciled

Added the `orch retry` command-table row + a `### retry` section; corrected the
now-stale `### resume` prose (it documented the old "resume on completed errors"
behavior — superseded by Phases 1–2: `completed` → read-only, `failed` →
interactive, no-TTY refuses); extended the `--prompt`/`--mode`/`--debug`/
`--interactive`/`--noninteractive` option rows to list `retry`; corrected the
`CANNOT_RESUME` exit-code description. `bun run docs:build` (the dead-link gate)
green.

## Design notes / decisions made

- **No TTY/headless branch was needed in `retryCmd`.** The plan describes a
  TTY-vs-headless split, but the actual divergence is entirely encoded in the
  `hostFactory` that `main.ts` already resolves from the run mode: a two-pane
  host on a TTY (the user watches the retry execute, AT-R6), a plain host
  headless (runs to completion without a TUI, AT-R8). `runResumeExecution` is
  host-agnostic and constructs **no** interactive failure view, action channel,
  or `ConfirmService` — exactly the plan's "must not share a code path that
  requires the TUI" property — so calling it unconditionally is correct and is
  the simplest thing that satisfies both branches of D8. This is why `retry.ts`
  is ~110 lines with no mode conditional.
- **`CANNOT_RESUME` reused, no new error type.** KTD-2 / open-Q1 leave
  rename-vs-reuse to the implementer; since the rejection never travels through
  the executor, an inline stderr message + the existing exit code is the minimal
  correct choice (mirrors how `resumeCmd` writes its no-TTY refusal inline).
- **`retryRun` split from `retryCmd` for the `loaded` test seam.** Same pattern
  as `openFailed`/`runResumeExecution`: the `COMMANDS`-shaped wrapper keeps its
  fixed signature and loads the workflow from disk in production; tests inject a
  `FakeRunner`-backed executor via `loaded` to drive real execution without a
  `.orch/workflows/` file.

## What remains (gated real-CLI / full-host — no new product code)

Identical in character to Phase 2's gated tail; these cannot run without a real
tmux or a real Claude/Codex binary and belong to `bun run check:release`:

- **AT-R6 rendered open** — that a real TTY `orch retry` *visibly opens* the run
  before the retry executes (the auto-continue + state advancement is proven; the
  on-screen render is the same gated full-host concern as AT-2).
- **AT-R5 / AT-R8 instruction recording** — a prompt-recording fake asserting the
  configured instruction is handed in, plus real fork/session-resume (Claude
  `--resume --fork-session`; Codex rollout-copy). The U4 resolver is wired
  through `retryRun` (delivers the default `'continue'`); the recorded-instruction
  + real-fork assertion is gated.

These are catalogued, not silently skipped, and are a documented verification
follow-up for a human running `check:release` locally.

## Surprises / notes for reviewers

- **No surprises.** The plan pinned the host-free `runResumeExecution` seam in
  U6 precisely so U8 would be thin; it was. The only source changes beyond the
  new `retry.ts` were one export in `resume.ts`, two lines in `main.ts`, and the
  docs reconciliation.
- **`ConfirmService` construction counter** is the load-bearing AT-R8 guard: a
  regression that copied `resume`'s no-TTY refusal, or that constructed the
  interactive failure view, would either touch the confirm service or fail to
  advance the run — both caught.
- **`writeFinishedRun` models only `completed`/`crashed`/`running`** (a failed
  step has no per-step status row), so the AT-R6/R8/R10 `failed` fixtures are
  produced by actually executing a failing workflow (the `open-failed` harness
  shape); the AT-R7/R9 fixtures, which never reach execution, use the cheap
  `writeFinishedRun` builder.

## Blockers

None. No blocker file written. The brainstorm's assumptions held end-to-end: the
retry verb was buildable entirely on the seams Phases 1–2 already pinned
(`runResumeExecution`, `resolveExplicitTarget`, `defaultInstructionResolver`),
with no schema migration and no new error type.
