# Phase 2 — Interactive `failed` view + retry core — implementation summary (round 1)

**Phase:** 2 of 3 (`plan.md` → "Interactive `failed` view + retry core + status-aware fallback")
**Status:** in-progress. This round landed **U4 in full** and the **core executor
primitive of U5** (the novel, highest-risk piece). The rest of U5 (host→CLI action
channel), U6, and U7 remain for a following round.
**Gate:** `lint`, `typecheck`, `test:unit` (1793), and `tests/integration/core` +
`tests/unit/core/recovery` (166) all green. No schema migration; no public-API barrel
change beyond new internal core exports.

## What this round ships

### U4 — Shared, configurable retry/continue instruction primitive (DONE)

Lifts the hardcoded `RECOVERY_NUDGE = 'continue'` (was `src/core/workflow.ts`) into a
`kind`-aware seam (D7 / KTD-4), so a manual retry can later deliver a configured
instruction while the autonomous loop keeps sending `'continue'` unchanged.

- **`src/core/recovery/instructions.ts`** *(new)* — `InstructionKind` (`'retry' | 'continue'`),
  `DEFAULT_RECOVERY_INSTRUCTION = 'continue'`, `resolveInstruction(kind, configured?)`, and a
  bound `InstructionResolver` + `defaultInstructionResolver`. Retry and continue are modelled
  as **distinct kinds** that both fall back to the same built-in default until a config schema
  exists — so the sibling feature can later supply distinct values without re-threading the
  seam. The typed-override input UI is deliberately **not** built here (sibling-owned; Non-goals).
- **`src/core/recovery/index.ts`** + **`src/core/index.ts`** — re-export the new symbols through
  the barrels (project rule #7).
- **`src/core/workflow.ts`** — added `WorkflowDeps.instructionResolver?` and rewired
  `buildRecoveryCommand` to resolve the nudge through `(deps.instructionResolver ??
  defaultInstructionResolver)('continue')` instead of the constant. The autonomous path leaves
  the resolver absent ⇒ still sends `'continue'` (zero behavior change).
- **`tests/unit/core/recovery/instructions.test.ts`** *(new)* — default for both kinds, per-kind
  override isolation, retry≠continue representable, default-resolver behavior.
- **Regression guard:** the pre-existing `tests/integration/core/recovery-loop.test.ts`
  (asserts `nudge: 'continue'` handed to `forkResumeCommand`) and `recovery-simulated.test.ts`
  still pass — the autonomous loop is unchanged.

### U5 (part a) — Single-step execution mode (`executor.retryStep`) (DONE)

The net-new "run exactly one step then re-park" primitive that `[r]` needs (KTD-5/KTD-8). It is
**host-free** and unit-testable on its own.

- **`src/core/workflow.ts`:**
  - New `WorkflowExecutor.retryStep(deps): Promise<RetryStepResult>` + the exported
    `RetryStepResult` discriminated type (`'retried-ok' | { 'failed-again', error }`).
  - `retryStep` loads the run, **refuses** any status other than `failed` (`ResumeError`), and
    — unlike `resume()` — **never** calls `setStatus('running')`. The run status stays `failed`
    throughout (KTD-8).
  - `executeWorkflowFn` gained an internal `ExecMode { singleStep? }`. In single-step mode it
    threads an `ExecControl { realStepRan }` into `runStepOnce`; `runStepOnce` (1) parks (throws
    the internal `SingleStepParked` control-flow signal) before any **top-level** step once a
    real step has already run, and (2) marks `realStepRan` the moment a step actually executes
    (cache replays don't count). The park is suppressed inside `parallel()` so a failed parallel
    block re-runs at the whole-block granularity `resume` uses today (KTD-7).
  - Single-step terminal handling writes **no run status** and emits **no `run:ended`** on any
    path: park signal ⇒ `retried-ok`; body completes (failed step was last) ⇒ `retried-ok`;
    step-level failure ⇒ re-thrown and classified to `failed-again`; a genuine crash re-throws.
  - The failed step's success is persisted by the normal `saveStep` path, so
    `projectStepsView`/`finalizeView` re-derives "step ok, run still failed, continue available"
    from step-level state — exactly the KTD-8 parked representation AT-R1/AT-R10a depend on.
- **`tests/integration/core/single-step-retry.test.ts`** *(new)* — drives the public executor
  over a real `FileStateStore` + `FakeRunner`:
  - fail-then-pass ⇒ only the failed step re-invoked, marked ok, **run stays `failed`**, the
    later step never ran (covers U5's "single-step executor" scenario / AT-R1 at the core level);
  - fail-again ⇒ `failed-again`, run stays `failed`;
  - non-`failed` run ⇒ `retryStep` refuses.
- **`tests/unit/core/workflow-typing.test-d.ts`** — updated the public-string-keys type assertion
  to include `retryStep`.

## Design notes / decisions made

- **Threaded the resolver via `WorkflowDeps` + `buildRecoveryCommand`, not via `RecoveryLoopDeps`.**
  The plan's U4 file list names `RecoveryLoopDeps`, but the recovery **loop** never builds the
  fork/resume command — `buildRecoveryCommand` (in `workflow.ts`) does, driven by the loop's
  injected `runAttempt`. Putting the resolver on `RecoveryLoopDeps` would have been an unused
  field (a maintainability smell). `WorkflowDeps` is exactly where the manual-retry path (U6/U8)
  constructs deps, so the seam is reachable there. The D7/AT-R5 contract (deliver the
  configured/default instruction; retry≠continue representable) is fully satisfied.
- **Park-*before*-execute, not after.** Checking "have we already run a real step?" at the top of
  `runStepOnce` (and skipping while `insideParallel`) is what makes the whole-block parallel
  granularity fall out correctly: branches run with `insideParallel === true` so none park, and
  the park fires only on the next top-level step after the block resolves.
- **`SingleStepParked` is a control-flow signal, not a user error.** It never escapes core; it's
  caught only by `executeWorkflowFn`'s single-step terminal branch.

## What remains in Phase 2 (next round)

- **U5 (part b) — host→CLI action channel** (not started): widen `ForegroundShutdownReason`
  (`src/hosts/host.ts`) to carry a user-action outcome (`retry` / `retry-continue`); add
  `{type:'retry'}` / `{type:'retry-continue'}` to `StepsViewIntent` (`steps-view.tsx`) and
  `StepsIntentSchema` (`start-steps-view.ts`); bind `[r]`/`[c]` in `steps-view.tsx` `useInput`
  **only when `state.status === 'failed'`**; resolve the shutdown deferred with the action in
  `tmux-host.ts` `composedIntent`; surface the third outcome from `execute-with-attach.ts`.
- **U6 — interactive `failed` open wired end-to-end** (not started): flip `orch resume
  <failed-id>` to **park** at the interactive failure view (no silent re-run); footer adds
  `[r]`/`[c]` (`end-of-run-summary.tsx`); an open loop in `resume.ts`/`open-finished.ts` reacts to
  the action outcomes — `[r]` ⇒ `executor.retryStep` (already landed), `[c]` ⇒ a **host-free
  `retryAndContinue` core** (≈ `resume()` with `instructionResolver` injected, the U8 seam);
  per-step transcript tee invalidation on retry for **both** Claude and Codex (KTD-6); the
  actioned side-effects matrix; cmux pill `failed→completed` only on a real continue (AT-R11).
- **U7 — status-aware bare-resume fallback** (not started): wire the existing `ConfirmService`
  (KTD-3) into the resume deps; offer the newest finished run with status-distinguishing copy;
  open the matching view on `y`, "nothing to resume" on `N`.

The U5 single-step primitive landed this round is the dependency U6's `[r]` consumes directly, so
the next round is host/TUI/CLI wiring on top of a tested core — not more executor surgery.

## Surprises / notes for reviewers

- **Scope reality.** Phase 2 is genuinely multi-PR-sized net-new infra (executor mode + host
  action channel + TUI + cross-runner tee + CLI fallback). I deliberately stopped at a **clean,
  fully-green boundary** (U4 + the U5 executor core) rather than land a half-wired action channel
  with no end-to-end consumer (which would have left dead branches in `execute-with-attach` and
  risked a red gate). Cross-round continuation is what the plan/orchestrator expect.
- **No `acceptance-tests.md` status flips this round.** The U5 executor core is proven by an
  integration test, but AT-R1/AT-R2 are written against the **real `orch resume` + rendered TUI**
  driving surface, which needs U6. Marking them ✅ now would over-claim — left `⬜ todo`.
- **No schema change.** `RunState.schemaVersion` stays `5`; the parked-after-retry state rides on
  the existing step-level attempt state (KTD-8), exactly as planned.

## Blockers

None. No blocker file written. The brainstorm's assumptions held: the single-step primitive was
buildable on the existing cache-replay + `runStepOnce` seam without a new run status or migration,
and the instruction seam shipped with a built-in default per D7.
