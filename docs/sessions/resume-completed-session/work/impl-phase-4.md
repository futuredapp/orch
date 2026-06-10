# Phase 2 — Interactive `failed` view + retry core — implementation summary (round 4)

**Phase:** 2 of 3 (`plan.md` → "Interactive `failed` view + retry core + status-aware fallback")
**Status:** in-progress. This round landed the **U6 core**: the CLI open loop that
flips `orch resume <failed-id>` from a silent re-run to the interactive failure
view, wired end-to-end to the U5 action channel + U5a single-step primitive +
U4 instruction seam. **U7** (status-aware bare-resume fallback) and the
full-host *rendered-footer* / cross-invocation / instruction-recording / cmux-pill
assertions remain.
**Gate:** `bun run check` green end-to-end (lint, typecheck, `bun run test`,
two-pane fast/screen/full-host/lifecycle, migration overlap/import-parity/`_migration`).
No schema migration; no public-API barrel change.

## What this round ships — U6 core: the interactive `failed` open loop

The dangerous legacy behavior this feature exists to remove — `orch resume
<failed-id>` **silently re-running the failed step** — is now gone. `failed`
routes to a deliberate, interactive re-entry.

### The behavior flip (`src/cli/commands/resume.ts`)

The `completed`-only finished-run branch now also handles `failed`:

- **No two-pane terminal** (no TTY / tmux unavailable) → **refuse**, status-named,
  `CONFIG_ERROR` (not `CANNOT_RESUME`, AT-6). The `failed` half is the key fix —
  a piped/CI `orch resume <failed>` no longer mutates anything (AT-20 failed half).
- **Two-pane** → `completed` → `openFinished` (Phase 1, unchanged); `failed` →
  the new `openFailed` loop.
- `crashed`/`running` still resume for real via the extracted `runResumeExecution`.

### `src/cli/commands/open-failed.ts` *(new)* — the view → action loop

`openFailed` loads the workflow once, then loops:

1. **`openFailedView`** mounts the interactive failure viewer (a fresh host per
   open, `enableFailureActions: true`) and `awaitForegroundShutdown` settles with
   the user's action. An un-actioned quit/detach runs **no executor** — pure
   observation (AT-R4).
2. **`[r]`** → `runSingleStepRetry` builds an executing host (logger-wired, NO
   cmux, NO preamble), runs `executor.retryStep()` (U5a single-step park, KTD-8),
   tears down, and **reopens** the view — the step now shows ok / failed-again, the
   run stays `failed`, `[c]` still offered (AT-R1, AT-R2).
3. **`[c]`** → `runResumeExecution` re-runs the failed step and drives the
   workflow to completion (KTD-5). Because it reuses the real resume host
   construction (with cmux), a success naturally fires `run:ended` + flips the
   pill `failed → completed` (AT-R3; AT-R11 path wired, assertion pending).

### `src/cli/commands/resume-execution.ts` *(new)* — shared execution seam

The proven resume execution block was lifted **verbatim** out of `resumeCmd` into
`runResumeExecution(args)`, now shared by:

- `resumeCmd` (the unchanged `crashed`/`running` real resume), and
- `openFailed`'s `[c]` continue,

with an optional `instructionResolver` (U4) injected on the manual path and an
optional pre-loaded `loaded` workflow (the test seam). This **is** the host-free
`retryAndContinue(runId, instructionSource)`-shaped seam the plan pins for U8's
headless `orch retry` — Phase 3 calls `runResumeExecution` with a plain host and
no `ConfirmService`/TUI. `mapResumeError` moved here too (re-exported usage).

### `src/cli/commands/execute-with-attach.ts` — surface the read-only reason

The `readOnly` branch now captures the settled `ForegroundShutdownReason` and
hands it to a new optional `onReadOnlyShutdown` callback (after teardown). That is
how `openFailedView` distinguishes a `{ type: 'action' }` (run a retry, reopen)
from a quit/detach (exit). `openFinished`'s pure read-only open omits the
callback, so Phase 1 behavior is byte-for-byte unchanged.

### Tests — `tests/integration/cli/commands/open-failed.test.ts` *(new)*

Drives the **real** `openFailed` / `resumeCmd` failed branch against a fake
two-pane host whose `awaitForegroundShutdown` is scripted to emit `[r]`/`[c]`/quit,
over a real `FileStateStore` + `FakeRunner`. The `failed` state is produced by
**actually executing** a three-step workflow whose middle step fails (real cache
state), so `[r]`/`[c]` re-run exactly as in production:

- AT-R4 — un-actioned quit: exit 0, byte-for-byte `state.json` unchanged, runner untouched.
- AT-R1 — `[r]` fail-then-pass: step2 re-invoked once → ok, run stays `failed`, step3 unrun, reopens then quits.
- AT-R2 — `[r]` fail-again: run stays `failed`, no success persisted, reopens.
- AT-R3 — `[c]`: `state.json` advances `failed → completed`, step3 runs.
- AT-20 (failed half) — `resumeCmd` with `mode: 'plain'` refuses (`CONFIG_ERROR`), runner untouched, state unchanged.

## Design notes / decisions made

- **Reopen-a-fresh-host-per-action model (matches U5b).** U5b made `[r]`/`[c]`
  unmount the steps-view child like `quit`. So the loop tears down and reopens a
  fresh viewer after each `[r]`, re-projecting the now-current `state.json`. This
  is the verifiable, side-effect-coherent design; the integration tests drive it
  directly (the factory hands out one host per iteration).
- **Extracted the resume execution rather than duplicating it.** `openFailed`'s
  `[c]` and the ordinary `crashed`/`running` resume are the *same* re-run; sharing
  one tested function (rather than a ~100-line copy) keeps the cmux/preamble/
  attach wiring in one place and pins the U8 host-free seam for free.
- **Tee invalidation (KTD-6) falls out of re-running through a logger-wired host.**
  The per-step `formatted_output.*` tee opens with `truncateOnOpen: true` on
  `step:start` against a fresh per-host tee map, so re-running the failed step
  through `runSingleStepRetry`'s executing host truncates + rewrites it — a later
  `⏎`/`orch resume` can't replay stale pre-retry bytes. No explicit invalidation
  call needed; the real-runner (Claude + Codex) assertion is gated real-CLI.
- **`[r]` uses persisted args; the prompt-override belongs to `[c]`/resume.** Kept
  the override (`setArgs`) semantics in `runResumeExecution` only.

## What remains in Phase 2 (next round)

- **U7 — status-aware bare-resume fallback.** Wire the existing `ConfirmService`
  (already on `CliDeps.confirmService`) into the bare `orch resume` path: prefer a
  resumable run; else confirm the newest finished run with status-distinguishing
  copy; open the matching view on `y` (completed → `openFinished`, failed →
  `openFailed`), "nothing to resume" on `N`. (AT-9..AT-12.)
- **Gated real-CLI / full-host validation for U6** (behavior is landed; these are
  the remaining *observable* assertions):
  - AT-2 / AT-3 — the **rendered** interactive footer via a real `orch resume`
    full-host scenario (footer affordances already model-covered round 3).
  - AT-R5 — a prompt-recording fake runner asserting the configured instruction +
    real fork/session-resume (Claude `--resume --fork-session`; Codex rollout-copy).
  - AT-R10 / AT-R10a — cross-invocation reopen after a CLI retry (load cleanly,
    correct view, tee coherent).
  - AT-R11 — cmux pill `failed → completed` on a real `[c]` continue (path wired;
    cmux-surface assertion pending, gate with `ORCH_DISABLE_CMUX` per the learning).
  - AT-18 / AT-19 (failed half) — `⏎`-inspect-in-failed-view is pure.

## Surprises / notes for reviewers

- **Scope reality (unchanged from rounds 1–3).** Phase 2 is multi-PR-sized. This
  round took the **U6 CLI loop + behavior flip** as a clean, fully-green,
  no-dead-branch boundary: every product path that opens a `failed` run now goes
  through the deliberate interactive loop, and the silent-re-run path is gone. The
  remaining U6 items are *additional observable assertions* (full-host rendered
  TUI, cross-invocation, cmux surface) best landed at the gated real-CLI level,
  plus U7.
- **The real-tmux "watch the retry execute" choreography is the one UX seam not
  validated here.** The loop is correct at the state/runner-boundary level (proven
  with fake hosts); how the user *watches* a `[r]` step re-run between viewer opens
  in real tmux is the gated full-host concern. Flagged, not silently skipped.
- **No schema change.** `RunState.schemaVersion` stays `5`; the parked-after-retry
  state rides on existing step-level attempt state (KTD-8).

## Blockers

None. No blocker file written. The brainstorm's assumptions held: the failed open
loop was buildable on the U5b action channel + U5a single-step primitive + the
extracted resume execution, with the silent-re-run path removed and no schema
migration.
