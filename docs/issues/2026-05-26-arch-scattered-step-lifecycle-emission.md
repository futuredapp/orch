---
date: 2026-05-26
status: resolved
resolved: 2026-05-26
area: src/core
type: architecture
recommendation: strong
dependency-category: in-process
---

# Step-lifecycle emission is hand-written per step kind

## Resolution (2026-05-26)

Extracted `src/core/step-lifecycle.ts` — a deep module behind a one-call
interface, `withStepLifecycle(ctx, body)`. The envelope owns `step:start`, the
parallel branch-update supplement, the `step:complete | step:failed` terminal
pair, the span tee, and the duration source; every per-kind executor
(`runInteractiveStep`, `runAgentStep`, the `command` and `ask` cases) shrinks
to "produce the value." The four hand-written copies and the
`emitStepFailure`/`emitStepSuccess`/`emitStepLifecycle` helpers are gone from
`workflow.ts`.

Tested once at the seam: `tests/unit/core/step-lifecycle.test.ts` pins the
trio, the timer-stamp override, the parallel branch-updates, and the
`trackParallel:false` opt-out.

**Duration source.** A `StepTimer` lets a body `stamp()` a runner-reported
duration; unstamped bodies get wall-clock. Interactive steps stamp the
session duration so `step:complete` reports the session, not the envelope's
spawn/capture/log overhead — preserving the pinned `durationMs: 2000` test.

**Two behaviour changes, both improvements, called out deliberately:**

1. *Bug fix.* `runAgentStep` previously threw `ValidationError` /
   `SchemaValidationError` past the emitters, firing `step:start` but **no
   terminal event** — leaving the step stuck `running` in the status
   projection. The envelope's `catch` now emits `step:failed` for these.
2. *Consistency.* `step:failed.error` now carries the **thrown error** for all
   kinds (interactive/agent previously emitted a terse hand-written string that
   disagreed with the richer `StepError` they threw). Host renderers already
   handle `unknown`; the failure frame embeds the original message either way.
   The span tee now stringifies the error before writing `lifecycle.ndjson`
   (an `Error` JSON-serializes to `{}`) — which also fixes the pre-existing case
   where `command`/`ask` failures logged `"error":{}`.

Per-kind lifecycle *coverage* is unchanged: `commit`/`worktree` remain
lifecycle-silent (not routed through the envelope) — extending lifecycle to
them is a separate, deliberate decision, out of scope here.

---

# Step-lifecycle emission is hand-written per step kind

## Problem

The `step:start → step:complete | step:failed` trio (plus the `inParallel`
branch-update special case and elapsed-time bookkeeping) is emitted by hand in
four separate places inside the 1388-line `src/core/workflow.ts`. The shape of
"what a lifecycle looks like" is spread across the implementation: changing the
ordering, the payload, or the parallel handling means four synchronised edits,
and a new step kind must remember to replicate the pattern.

## Files

- `src/core/workflow.ts` (1388 lines)
  - `runInteractiveStep` — `:468` (start), `:597` (failed), `:607` (success)
  - `runAgentStep` — `:853` (start), `:914` (failed), `:934` (success)
  - command case in `runStepOnce` — `:1245`, `:1273`, `:1277`
  - ask / commit cases — `:1209`–`:1236`
- helpers `emitStepLifecycle` (`:334`), `emitStepFailure` (`:653`),
  `emitStepSuccess` (`:672`) — already exist, but the *call sequencing* is duplicated

## Solution

A single `withLifecycle(key, mode, run)` envelope emits `step:start`, times the
body, and emits `step:complete` or `step:failed` (including the parallel
branch-update). Each per-kind executor shrinks to "produce the value." The
exhaustive `runStepOnce` switch dispatches into per-kind executors that no
longer touch lifecycle.

## Wins

- Locality: lifecycle rules concentrate in one module
- Leverage: one interface, every step kind
- Test the trio once, not once per kind
- First clean cut into the `workflow.ts` god module

## Recommendation strength

**Strong.** High locality leverage; opens the path to taming the god module
without a risky full split.
