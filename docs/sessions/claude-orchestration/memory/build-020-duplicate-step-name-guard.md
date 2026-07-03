# build-020: throw on a duplicate step name in the same scope

## What I did

Implemented plan 020: a same-scope duplicate step name coming from a DIFFERENT step definition now throws an actionable `DuplicateStepNameError` instead of silently returning the first step's memoized value.

Changes (only in-scope files):

- `src/core/errors.ts` — added `export class DuplicateStepNameError extends Error` taking `readonly stepName: StepName`, with the plan's message, `this.name = 'DuplicateStepNameError'`, and `Object.setPrototypeOf(this, new.target.prototype)`.
- `src/core/workflow.ts`
  - Added `readonly step?: AnyStep` to the `StepKeyOwner` interface (optional - see decision below).
  - Set `step: s` when building `attemptedOwner`. Left `cachedOwner` untouched.
  - Imported `DuplicateStepNameError` from `./errors.ts` and added it to the `./workflow.ts` errors re-export.
  - Extended `assertNoExecutionCollision`: after the cross-scope `StepNameCollisionError` throw, throw `DuplicateStepNameError` when `prior.step !== attempted.step && step.config.kind === 'agent'`.
- `src/core/index.ts` — surfaced `DuplicateStepNameError` in the errors re-export block (same pattern as `StepNameCollisionError`).
- `tests/unit/core/run-step-once-collision.test.ts` — added a new describe block with the 3 required regression cases.

## Drift check

`git diff --stat 0265592..HEAD -- src/core/workflow.ts src/core/errors.ts`: workflow.ts changed (+16/-1), errors.ts unchanged. The workflow.ts drift is entirely in `runAgentWithRecovery` (~lines 1575-1600, recovery/fail-fast logging), well away from the guard region. All the plan's "Current state" excerpts still match live code (line numbers shifted ~+14). No mismatch - proceeded.

## Key decisions

1. **`step` is optional (`readonly step?: AnyStep`), not required.**
   The task said "add `readonly step: AnyStep`" AND "leave the `cachedOwner` alone". Those conflict: a required field forces the `cachedOwner` literal to add `step`. Optional satisfies both - `cachedOwner` compiles untouched, and only `attemptedOwner` carries `step: s`. It is functionally identical to required for the guard: `keyOwnersThisExecution` only ever stores `attemptedOwner` values (all carry `step`), so the `prior.step` compared in the guard is always defined.

2. **Gated the throw on `step.config.kind === 'agent'` - deviation from the plan's literal `if (prior.step !== attempted.step)`.**
   The literal guard broke TWO existing product-feature tests in `tests/unit/core/worktree-executor-cache.test.ts`:
   - "step is memoized - second invocation returns cached WorktreeResult without calling git"
   - "createWorktree throws when two different branches slug to the same step name within one workflow"

   Root cause: `createWorktree(...)` is a FACTORY that returns a fresh `Object.freeze({...})` on every call, so two calls with the same branch are two DIFFERENT objects sharing the name `worktree:<slug>`. Its by-name memoization is an INTENDED, documented feature (worktree.ts:72 "Memoization is the only safety net for replay"), and it has its OWN cache-hit value guard in `onCacheHit` (step.ts:428) that throws a branch-mismatch error naming both branches - which is exactly what test 3 asserts. The literal guard pre-empted that better error and broke the idempotency.

   This is neither of the two buckets the master offered ("relied on the bug" / "same object false-positive") - it is intended factory idempotency. Classification: the footgun the plan targets is exclusively `step.define` copy-paste (agent kind). `step.define` is the sole producer of `kind: 'agent'` and REJECTS the factory prefixes (`worktree:`/`ask:`/`command:`, step.ts:279), so an agent key can never alias a factory key; the prior owner of an agent key is necessarily an agent step. Gating on `step.config.kind === 'agent'` is therefore the precise realization of the plan's intent: it catches the `step.define` footgun while leaving worktree/ask/command factory idempotency (and their own cache-hit guards) intact. All three regression tests use `step.define` agent steps, so the guard still fires for them.

## What I verified

- `bun test tests/unit/core/run-step-once-collision.test.ts` -> 9 pass / 0 fail (6 pre-existing + 3 new).
- `bun test tests/unit/core/worktree-executor-cache.test.ts` -> all pass (confirming the kind gate preserved worktree behavior).
- `bun test tests/unit/core tests/integration/core` -> 744 pass / 0 fail.
- `bun run typecheck` -> exit 0.
- Path-scoped only; did NOT run `bun run check`, bare `bun test`, or any git command, and did NOT edit `plans/README.md` (per the hard constraints, even though the plan body asks to update the README row).

## Left for later / residual risk

- **Command/ask double-invocation footgun is NOT caught.** Because the guard is gated to agent kind, two `command('build', ...)` calls with different scripts but the same name (different objects) still silently alias to the first result - `onCacheHit` for `command` only validates value shape, not arg equivalence (step.ts:448). This is pre-existing behavior; the plan scoped the fix to the `step.define` copy-paste case and did not mention command/ask. A follow-up could extend a value-equivalence guard to command/ask factories, but that is a separate design decision, not this plan.
- **Deviation flagged for reviewer.** The `step.config.kind === 'agent'` gate is a deliberate, principled narrowing of the plan's literal `prior.step !== attempted.step`. If the master intends the guard to fire for ALL step kinds, that requires first reconciling it with worktree's intended by-name idempotency and its `onCacheHit` branch guard - do not simply drop the gate, or the two worktree tests go red again.
- The `plans/README.md` row 020 was intentionally left unchanged per the hard constraint; the master/workflow owns that update.
