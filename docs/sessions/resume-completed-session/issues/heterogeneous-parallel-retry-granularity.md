# Single-step retry can run multiple branches in heterogeneous `parallel([run(...)])`

**Source:** Codex Finding 5 (MEDIUM). Verified against the code.
**Status:** Not a fix in this pass — the end-outcome matches KTD-7's intended granularity; the proper fix is
net-new parallel-context infra. But the mechanism is an unverified race and the code comment is inaccurate.

## What the issue is

The single-step retry park guard is meant to re-invoke **exactly** the failed step once, then park (AT-R1).
For the **heterogeneous** parallel form `parallel([run(A), run(B)])`, multiple uncached branches can clear
the park check and execute concurrently in a single `[r]` action, instead of one step then park.

## Where it is

- Park guard: `src/core/workflow.ts:1824` —
  `if (execControl?.singleStep === true && execControl.realStepRan.current && !insideParallel) throw new SingleStepParked()`.
  `realStepRan.current` is only flipped **later**, at `src/core/workflow.ts:1905`, after the cache lookup at
  `:1854`.
- `isInsideParallel()` (`src/core/execution-context.ts:107-110`) is true only when `insideParallel`/
  `parallelDepth` are set, and those are set **only** by the homogeneous branch wrapper
  (`src/core/parallel.ts:180-182`). The heterogeneous path (`src/core/parallel.ts:119-136`) never runs its
  branches inside that context — and in `parallel([run(A), run(B)])` the `run()` calls are evaluated
  (entering `runStepOnce`) **before** `parallel()` is even called.

So for every heterogeneous branch, `insideParallel === false` and, in the window between the guard (`:1824`)
and the `realStepRan` flip (`:1905`), `realStepRan.current === false` for all of them — neither parks, and
both execute.

## Why it matters / why severity is bounded

- **Outcome matches intent.** Plan **KTD-7** and **A2** resolve parallel retry granularity as "same as
  resume" / whole-block: a failed parallel block re-runs at whole-block granularity via cache-replay. So
  multiple branches re-running is the *intended* end state, and the homogeneous form achieves it
  deterministically (its `insideParallel: true` suppresses the park).
- **But the heterogeneous form reaches it by accident**, via a lost `realStepRan` race rather than the
  `!insideParallel` mechanism. Two concrete problems remain:
  1. The explanatory comment at `src/core/workflow.ts:1820-1823` (and the CE review's "Verified correct"
     note, which only reasoned about the homogeneous case) describe a suppression mechanism that does **not**
     apply here — misleading for the next maintainer.
  2. It is an unpinned concurrency race: any future change that flips `realStepRan` more eagerly, or a
     cache-hit on one branch, could make behavior order-dependent. **No test** covers a failed heterogeneous
     parallel block with ≥2 failed branches.

## Why it is recorded here, not fixed

A correct fix is retry-aware parallel handling — make heterogeneous `parallel()` establish a parallel
execution context before its branches enter `runStepOnce`, or introduce a block-level retry claim so the
whole current block is deliberately retried and no unrelated later top-level step can start. That touches the
parallel execution model (net-new infra), which is scope beyond this review pass, and the user-visible
granularity already matches KTD-7.

## Suggested next step

- Short term: correct the comment at `src/core/workflow.ts:1820-1823` to state that heterogeneous parallel
  branches are *not* gated by `insideParallel` and rely on whole-block cache-replay, and add an integration
  test pinning the intended granularity for a two-failed-branch heterogeneous block.
- Longer term: wrap heterogeneous branch execution in a parallel context (or a block-level retry claim) so
  the single-step invariant is enforced by mechanism, not by a race.
