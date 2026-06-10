# Single-step park assumes the failed step is the first non-cache-hit step (stale-`ask` edge)

**Source:** CE L5 (LOW). Verified against the code.
**Status:** Not a fix in this pass — low likelihood, contradicts the AT-R10 coherent-replay precondition.

## What the issue is

The single-step retry park fires once `realStepRan` flips on the first **real** (non-cache) execution. In a
normal `failed` run every prior step is a cache-hit, so the first real execution is the failed step —
correct. There is one way `realStepRan` could flip earlier: a **stale `ask`** entry whose cache is invalid
(`isAskCacheValid` false), e.g. because the workflow's `ask` buttons/fields were edited between the original
run and the retry. The stale ask re-runs, flips `realStepRan`, and the actually-failed step then parks
**before** re-running — so `[r]` "retries" the wrong step.

## Where it is

- `src/core/workflow.ts:1824-1826` — the park guard (`realStepRan.current && !insideParallel → SingleStepParked`).
- `src/core/workflow.ts` ~`:1905` — where `realStepRan.current` is flipped on the first real execution.

## Why it matters

If it triggers, `[r]` parks at the wrong step and the user's retry doesn't re-run the failed step. However,
it requires editing the workflow's ask definition between the original run and the retry, which contradicts
the AT-R10 "coherent replay" precondition (a later resume/retry assumes the workflow is unchanged enough to
replay). Low likelihood, and outside the contract's stated assumptions.

## Why it is recorded here, not fixed

It is an edge case gated by a precondition the contract already assumes away, so a guard is not urgent and
adding one risks complicating the park logic for a case the feature doesn't promise to handle.

## Suggested next step

At minimum, add a comment at `src/core/workflow.ts:1824` documenting the assumption ("single-step park
assumes the failed step is the first non-cache-hit step; a stale/invalidated `ask` re-running first would
park the wrong step"). Optionally, key the park on the specific failed step id rather than "first real
execution" if this is ever observed in practice.
