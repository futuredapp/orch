---
title: "feat: Resume end-to-end"
type: feat
status: completed
date: 2026-04-13
phase: 11
deepened: 2026-04-13
---

# Phase 11 — Resume End-to-End

## Enhancement Summary

**Deepened on:** 2026-04-13
**Sections enhanced:** 8
**Research agents used:** kieran-typescript-reviewer, architecture-strategist, pattern-recognition-specialist, performance-oracle, code-simplicity-reviewer, security-sentinel, spec-flow-analyzer, best-practices-researcher, repo-research-analyst

### Key Improvements
1. **`ResumeError.status` narrowed** from `string` to `RunState['status']` — free type safety, consistent with `StateStore.setStatus` signature
2. **`ResumeError` message rewritten** to accurately reflect the acceptance matrix (both `'running'` and `'crashed'` are accepted)
3. **`executeWorkflowFn` hoisted to module level** — every other private helper in `workflow.ts` is a module-level function; a nested closure would break the established pattern
4. **Error classes extracted to `src/core/errors.ts`** — `workflow.ts` is already at 332 lines (over the 300-line limit); adding resume code without extraction pushes to ~350
5. **Unit guard tests use `FakeFsService + FileStateStore`** (not ad-hoc StateStore stubs) — mock only at `*Service` ports per project rule #3
6. **Three new test cases added** — resume with `parallel()` branches, resume with commit steps, resume on run with zero completed steps
7. **Known limitations expanded** — zombie process risk, `execute()` status hygiene gap, and in-process concurrent resume documented

### New Considerations Discovered
- The `execute()` on a `'crashed'` run never resets status to `'running'` — the stale-status problem persists on the implicit resume path. Documented as a known asymmetry.
- Redundant `loadRun()` calls during resume (N+3 for N steps) are negligible at current scale but worth a caching `StateStore` wrapper in a future phase.
- The architecture closely matches Inngest's proven step-memoization model — the design is validated by production workflow engines.
- The inner `catch {}` comment explaining the swallow must survive the helper extraction.

---

## Overview

Add a `resume()` method to `WorkflowExecutor` that formalizes crash recovery into an explicit API. Today, resume works *implicitly* — calling `execute()` with the same `runId` skips completed steps via memoization and `initRun()` is a no-op for existing runs. Phase 11 wraps this into a first-class DX with proper guards, status transitions, and distinct error types ready for Phase 12's CLI.

## Problem Statement / Motivation

The implicit resume path has three problems:

1. **No safety net** — `execute()` on a completed run silently re-enters the workflow. A typo in `runId` routing can replay a finished workflow with real side effects.
2. **No status hygiene** — calling `execute()` on a crashed run never flips status from `'crashed'` back to `'running'`, so mid-resume queries return stale `'crashed'` status.
3. **Unclear intent** — there's no semantic distinction between "start fresh" and "recover from crash" at the API level. Phase 12's `orch resume <id>` needs a dedicated entrypoint.

## Proposed Solution

```typescript
const wf = workflow('my-wf', async (run) => {
  await run(STEP_A)
  await run(STEP_B)
  await run(STEP_C)
})

// Fresh run:
await wf.execute({ runId, ...deps })

// Resume a crashed run:
await wf.resume({ runId: crashedId, ...deps })
```

`resume()` is thin:

1. `loadRun(runId)` — throw `RunNotFoundError` if undefined
2. Check status — throw `ResumeError` if `'completed'`
3. `setStatus(runId, 'running')` — reset from `'crashed'` or stuck `'running'`
4. Delegate to `executeWorkflowFn(fn, deps)` — shared with `execute()`

## Technical Considerations

### Status acceptance matrix

| Current status | `execute()` | `resume()` |
|---|---|---|
| (no run exists) | Creates run | `RunNotFoundError` |
| `'running'` | No-op via `initRun`, re-enters | **Allowed** — resets to `'running'`, re-enters |
| `'crashed'` | No-op via `initRun`, re-enters | Resets to `'running'`, re-enters |
| `'completed'` | No-op via `initRun`, re-enters | `ResumeError` |

**Critical:** `resume()` accepts `'running'` status, not just `'crashed'`. A SIGKILL/power loss never transitions to `'crashed'` — the state file is left at `'running'`. Rejecting `'running'` would break the most realistic failure mode.

### Research Insights: Status Model

**Best Practices (from Temporal, Inngest, Step Functions):**
- The 3-state model (`running`/`completed`/`crashed`) is sufficient for the current scope. Production engines use 5-7 states but they include `queued`, `cancelled`, `suspended`, and `timed-out` — none of which apply to a synchronous single-process CLI.
- Inngest's model is the closest match: step memoization by hashed ID, re-invocation on resume, server-supplied cached step data. The plan's `runStepOnce` is architecturally equivalent.
- The guard checks "completed" (reject) rather than checking for "crashed OR running" (accept). This positive-match-on-rejection is the correct approach: future status values would default to "allowed," which is the right posture for a resume operation.

**Edge Cases:**
- `resume()` on a run with zero completed steps (crashed before any step ran): status is `'crashed'`, guard passes, all steps re-execute from scratch. Correct by design — add a test case.
- `resume()` where all steps are cached but terminal `setStatus('completed')` failed: status is `'running'`, all steps memoized, resume sets `'running'` then skips all steps and sets `'completed'`. Correct — add a test case.

### `execute()` backward compatibility

`execute()` is **unchanged**. Adding a guard to `execute()` for existing runs is a breaking change and out of scope. The implicit resume path continues to work; `resume()` is the preferred crash-recovery API.

**Known asymmetry (documented, not fixed):** `execute()` on a `'crashed'` run never resets status to `'running'` — the status remains stale `'crashed'` throughout re-execution, only flipping to `'completed'` or `'crashed'` at the terminal state. This is the exact problem `resume()` solves. Phase 12's CLI should use `resume()` for crash recovery, not `execute()`.

### Shared helper extraction

Steps 3-4 of the implementation (create `run` closure, call `fn(run)`, set terminal status with inner try-catch) are identical between `execute()` and `resume()`. Extract into a **module-level** private `executeWorkflowFn(fn, deps)` function.

**Why module-level, not nested closure:** Every other private helper in `workflow.ts` (`runStepOnce`, `runAgentStep`, `runCommitStep`, `assemblePrompt`, `safeHeadSha`, `checkSchemaCapability`, `revalidateCachedValue`, `validateSchemaOutput`) is defined at module level. Making `executeWorkflowFn` a nested closure inside `workflow()` would be the first instance of this pattern and break the file's structural consistency. Hoisting it and passing `fn` as an explicit parameter keeps the convention intact and makes the dependency on the workflow function visible.

```typescript
// src/core/workflow.ts — module-level private helper
// Shared execution body for execute() and resume().
// Receives `fn` explicitly rather than capturing it in a closure — matches
// the module-level convention of all other private helpers in this file.
async function executeWorkflowFn(
  fn: (run: RunFn) => Promise<void>,
  deps: WorkflowDeps,
): Promise<void> {
  const run: RunFn = <T>(s: Step<T>, overrides?: RunOverrides): Promise<T> =>
    runStepOnce(deps, s, overrides) as Promise<T>

  try {
    await fn(run)
    await deps.stateStore.setStatus(deps.runId, 'completed')
  } catch (err) {
    try {
      await deps.stateStore.setStatus(deps.runId, 'crashed')
    } catch {
      // Swallow setStatus failure — if initRun failed (disk full) or the state
      // file was deleted mid-run, the catch tries setStatus which throws.
      // Without this inner try-catch, the original error is lost.
      // For the resume() path, the run is known to exist (loadRun succeeded),
      // so this only fires on I/O errors (disk full, permissions).
    }
    throw err
  }
}
```

### Error types

```typescript
// src/core/errors.ts

import type { RunId } from './types.ts'
import type { RunState } from '../state/index.ts'

export class StepError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly exitCode: number,
    message: string,
  ) {
    super(`Step "${stepName}" failed (exit ${exitCode}): ${message}`)
    this.name = 'StepError'
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: RunId) {
    super(`Cannot resume: run "${runId}" not found`)
    this.name = 'RunNotFoundError'
  }
}

export class ResumeError extends Error {
  constructor(
    readonly runId: RunId,
    readonly status: RunState['status'],
  ) {
    super(`Cannot resume run "${runId}": run already completed`)
    this.name = 'ResumeError'
  }
}
```

### Research Insights: Error Design

**Pattern consistency:**
- Both follow the exact pattern of `StepError` (the direct precedent in the same module): extend `Error`, set `this.name`, store structured context as `readonly` fields. No `Object.setPrototypeOf` — consistent with `StepError`, `ParallelError`, `ProcessSpawnError`, and `StateCorruptionError` which also omit it.
- `ResumeError.status` uses `RunState['status']` (not `string`) — consistent with `StateStore.setStatus` which uses the same narrow type. Prevents construction with typos like `new ResumeError(id, 'compelted')`.
- `ResumeError` message changed from `not "crashed"` to `run already completed` — accurate because `'completed'` is the only rejection case. The old message implied only `'crashed'` is accepted, which is false (both `'crashed'` and `'running'` are accepted).

**Error class extraction:**
- `StepError` moves from `workflow.ts` to `src/core/errors.ts` alongside the new errors. This gives `workflow.ts` ~25 lines of breathing room, keeping it under the 300-line limit after adding `resume()` and the shared helper. `src/core/index.ts` re-exports all three errors — the public API is unchanged.

**Phase 12 CLI consumption pattern:**
```typescript
try {
  await wf.resume(deps)
} catch (err) {
  if (err instanceof RunNotFoundError) {
    console.error(`Run not found: ${err.runId}`)
    process.exit(2)
  }
  if (err instanceof ResumeError) {
    console.error(`Cannot resume: ${err.message}`)
    process.exit(3)
  }
  throw err // Unknown error
}
```

### Known limitations

- **Cross-process races:** Two processes calling `resume()` simultaneously can both pass the guard. `FileStateStore.#writeQueue` serializes within a single process only. Out of scope — Phase 12's CLI is single-process.
- **No `initRun()` call:** `resume()` skips `initRun()` since it already validates the run exists and resets status directly. If `initRun()` gains side effects in the future, `resume()` will need updating. Add breadcrumb comments in both `resume()` and `initRun()` to link the two paths.
- **Zombie process risk:** If `resume()` is called on a `runId` while the original `execute()` is still alive, both will race on the state file. The atomic write pattern prevents corruption, but step results may be overwritten and terminal status may be inconsistent. Phase 12's CLI should warn if the state file's mtime is recent (suggesting an active process).
- **In-process concurrent resume:** `Promise.all([wf.resume(deps), wf.resume(deps)])` with the same `runId` is not guarded. Both calls pass the status check and execute concurrently. A `Set<RunId>` in the workflow closure could prevent this cheaply — defer to a future phase if needed.
- **`execute()` status asymmetry:** `execute()` on a `'crashed'` run re-enters without resetting status to `'running'`. Mid-execution queries see stale `'crashed'` status. This is the explicit motivation for `resume()` but the gap remains on the implicit path. Phase 12's CLI should always use `resume()` for crash recovery.

### Research Insights: Security

**Severity: Low overall risk.** The security sentinel found no critical or high-severity issues:
- **RunId path traversal:** Well-mitigated by two independent layers — `RUN_ID_PATTERN` (`^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$`) excludes all special characters, and the `path()` smart constructor rejects `..` and NUL bytes.
- **State file trust:** `loadRun()` validates all fields via Zod including the regex-constrained `preRunSnapshot.headSha` (blocks git argument injection). Steps with `returns:` schemas get re-validated via `revalidateCachedValue()`. Steps without `returns:` return `unknown` (consumer's responsibility).
- **Error information leakage:** `RunNotFoundError` and `ResumeError` include `runId` in messages. Appropriate for a CLI developer tool — `runId` format contains no sensitive data (timestamp + random slug).

### Research Insights: Performance

**Current impact: negligible.** The dominant cost in any real workflow is subprocess execution (agent CLI calls taking seconds to minutes). State management overhead is sub-millisecond for typical workflows (2-10 steps).

**Redundant `loadRun()` pattern:** `resume()` calls `loadRun()` (guard) → `setStatus()` (internally calls `loadRun()` again) → `executeWorkflowFn()` where every `runStepOnce()` also calls `loadRun()`. Total: N+3 disk reads for N cached steps. For a 10-step workflow crashed at step 7: 16 disk reads + JSON.parse + Zod validation. Still under 20ms.

**Future optimization (defer, not Phase 11):** A single-entry caching `StateStore` wrapper scoped to the `resume()`/`execute()` call lifetime would reduce disk reads from O(N+M) to O(M). ~30 lines, no interface changes. Implement when step counts exceed 20 or profiling shows I/O as a bottleneck.

## Acceptance Criteria

### Functional

- [x] `WorkflowExecutor` has a `resume(deps: WorkflowDeps): Promise<void>` method
- [x] `resume()` on non-existent `runId` throws `RunNotFoundError`
- [x] `resume()` on `'completed'` run throws `ResumeError`
- [x] `resume()` on `'crashed'` run resets status to `'running'` and re-executes
- [x] `resume()` on `'running'` run (stuck from SIGKILL) resets status to `'running'` and re-executes
- [x] Memoization skips already-completed steps during resume
- [x] Failed step during resume sets status back to `'crashed'`
- [x] Successful resume sets status to `'completed'`
- [x] `RunNotFoundError` and `ResumeError` are exported from `src/core/index.ts`
- [x] `execute()` behavior is unchanged (no breaking changes)

### Non-Functional

- [x] `workflow.ts` stays under 300 lines after changes (enabled by error class extraction to `errors.ts`)
- [x] `bun run check` passes
- [x] No `any` or `!` non-null assertions

### Quality Gates

- [x] Integration tests: resume guards (completed, missing, running)
- [x] Integration tests: FakeRunner crash+resume (sequential)
- [x] Integration tests: double-resume (crash → resume → crash → resume)
- [x] Integration tests: resume with `parallel()` branches (partial branch success)
- [x] Integration tests: resume with commit steps
- [x] Integration tests: resume on run with zero completed steps
- [x] Integration tests: ClaudeRunner + FakeProcessService crash+resume
- [x] Integration test: status is `'running'` during resume execution (read inside callback)
- [x] E2E test (gated `RUN_REAL_CLAUDE=1`): real Claude crash+resume

## Implementation Phases

### Step 1: Error types in `src/core/errors.ts` + `WorkflowExecutor` interface update

**Files:**
- `src/core/errors.ts` — **new file**: move `StepError` here, add `RunNotFoundError`, `ResumeError`
- `src/core/workflow.ts` — remove `StepError` class, import from `errors.ts`, add `resume` to `WorkflowExecutor` interface
- `src/core/index.ts` — re-export new types from `errors.ts`

```typescript
// src/core/workflow.ts:64-67 — update interface
export interface WorkflowExecutor {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
  /** Resume a crashed or stuck run. Accepts 'crashed' or 'running' status.
   *  Throws RunNotFoundError if the run does not exist.
   *  Throws ResumeError if the run is already completed.
   *  Single-process only — no cross-process locking. */
  resume(deps: WorkflowDeps): Promise<void>
}
```

**Research Insight — error class placement:** Extracting `StepError` alongside the new errors into `src/core/errors.ts` reduces `workflow.ts` by ~10 lines (the class definition) and provides a single location for all core error types. The barrel at `src/core/index.ts` re-exports everything — the public API is unchanged. File stays under 300 lines.

### Step 2: Extract shared helper + implement `resume()`

**Files:**
- `src/core/workflow.ts` — extract module-level `executeWorkflowFn(fn, deps)` from `execute()`, implement `resume()` using the same helper

The `workflow()` factory returns:

```typescript
return {
  name,
  async execute(deps) {
    await deps.stateStore.initRun(deps.runId)
    await executeWorkflowFn(fn, deps)
  },
  async resume(deps) {
    // Skip initRun() — resume validates existence and resets status directly.
    // See initRun() in FileStateStore for the execute() path.
    const state = await deps.stateStore.loadRun(deps.runId)
    if (state === undefined) throw new RunNotFoundError(deps.runId)
    if (state.status === 'completed') throw new ResumeError(deps.runId, state.status)
    await deps.stateStore.setStatus(deps.runId, 'running')
    await executeWorkflowFn(fn, deps)
  },
}
```

Also add a breadcrumb comment in `FileStateStore.initRun()`:
```typescript
// Note: resume() bypasses initRun() — it uses loadRun() + setStatus() instead.
// If this method gains side effects, update resume() accordingly.
```

**Research Insight — guard ordering:** Guards are ordered cheapest/most-likely-to-fail first: (1) existence check via `loadRun`, (2) status field check. This matches the guard pattern best practice from production workflow engines.

### Step 3: Integration tests — FakeRunner crash+resume

**Files:**
- `tests/integration/core/resume.test.ts`

**Test cases:**
1. **Four-step crash at step 3, resume completes all** — same pattern as existing `workflow.test.ts:85` but using `wf.resume()` instead of second `wf.execute()`. Assert: `'crashed'` after first run, steps A+B cached, `resume()` skips A+B (invocationCount=0), runs C+D, final status `'completed'`, all 4 steps in state.
2. **Resume resets status to `'running'` before re-executing** — verify intermediate status is `'running'` (not stale `'crashed'`) by reading state inside a step callback during resume.
3. **Double resume: crash → resume → crash → resume** — 4-step workflow, first run crashes at C, first resume crashes at D, second resume completes. Assert step counts and final state.
4. **Resume on run with zero completed steps** — workflow crashes before any step completes (workflow function throws before first `run()` call). Resume re-executes all steps.
5. **Resume with `parallel()` branches** — `parallel([run(A), run(B)])` where B fails. Resume: A is cached (invocationCount=0), B re-executes. Assert both steps in final state. *(New test case from spec-flow analysis)*
6. **Resume with commit steps** — agent step succeeds, commit step crashes (via FakeGitService), resume: agent cached, commit re-runs. *(New test case from spec-flow analysis)*
7. **Resume guards: completed, missing, running** — Three test cases verifying `ResumeError`, `RunNotFoundError`, and acceptance of `'running'` status:
   - `resume()` on completed run throws `ResumeError` with correct `runId` and `status`
   - `resume()` on non-existent runId throws `RunNotFoundError` with correct `runId`
   - `resume()` on stuck `'running'` run succeeds (manually set status to `'running'` via `setStatus`)

**Research Insight — test patterns:**
- Use `makeIntegrationDeps()` with `BunFsService` + `FileStateStore` on tmpdir (existing pattern). Do NOT create ad-hoc StateStore stubs — mock only at `*Service` ports per project rule #3.
- Error assertions: use `try/catch` with `expect(err).toBeInstanceOf(RunNotFoundError)` and field checks for `err.runId` — matches existing `StepError` assertion pattern.
- When testing crash+resume, pass a **shared `runId`** to both dep sets but use **fresh `FakeProcessService` instances** for each execution phase (existing pattern from `workflow.test.ts:85-146`).

### Step 4: Integration tests — ClaudeRunner + FakeProcessService crash+resume

**Files:**
- `tests/integration/runners/claude/claude-resume.test.ts`

**Test cases:**
1. **Two-step workflow, step 2 fails via error NDJSON, resume succeeds** — Step 1 uses `simple-success.jsonl`, step 2 uses `error-max-turns.jsonl` on first invocation, `simple-success.jsonl` on resume. Assert memoization of step 1 (FakeProcessService not re-invoked for step 1's argv), step 2 re-runs, final status `'completed'`.

**Research Insight — test value:** The simplicity reviewer noted this test has marginal value since ClaudeRunner is unaware of resume — the memoization is entirely in `runStepOnce`. However, it validates that NDJSON fixture-based runner scripting works correctly across the crash+resume boundary, which is the primary integration concern for Phase 12's real-world usage. Keep it as a single focused test case.

### Step 5: E2E test (gated)

**Files:**
- `tests/e2e/resume-real-claude.test.ts`

**Test case (gated by `RUN_REAL_CLAUDE=1`):**
1. Two-step workflow: step 1 = real Claude "Reply with exactly: OK", step 2 = FakeRunner that crashes on first invocation.
2. Assert status is `'crashed'`, step 1 is cached.
3. `resume()`: step 1 cached (real Claude not re-invoked), step 2 scripted to succeed.
4. Assert final status `'completed'`, both steps in `state.json`.

**Note:** Step 2 uses FakeRunner (not real Claude) for the crash — real Claude doesn't "crash on demand". The E2E value is proving that a real Claude result survives memoization across a resume boundary.

**Research Insight — mixed runner setup:** The E2E test mixes real and fake runners in one workflow. The workflow function must accept both runner types, which requires per-run construction with different runner instances (same pattern as existing integration tests).

### Step 6: Update roadmap

**Files:**
- `docs/plans/implementation-phases.md` — flip Phase 11 from ☐ to ✓, add `**Landed:**` date, link to this plan

## Dependencies & Risks

**Dependencies:**
- All prior phases (0-10) landed ✓
- No new external dependencies

**Risks:**
- **Low:** `workflow.ts` line count. Mitigated by extracting error classes to `src/core/errors.ts` as part of Step 1 (not deferred — the file is already at 332 lines, above the 300-line limit).
- **Low:** `ResumeError` message clarity. Resolved: message changed to `run already completed` which is unambiguous.
- **Low:** Memoization key collision if two steps share the same name. Existing risk not introduced by Phase 11. A future phase could add a `Set<StepName>` in the run closure to detect duplicates.
- **Low:** Schema evolution between crash and resume. Existing `revalidateCachedValue()` throws `SchemaValidationError` for cached values that no longer parse — correct fail-loud behavior.

## User Flow Map

### Happy paths
1. **Fresh execute** → `execute()` → `initRun` → all steps run → `'completed'`
2. **Crash + resume** → `execute()` → steps A,B succeed → step C crashes → `'crashed'` → `resume()` → A,B cached → C,D run → `'completed'`
3. **SIGKILL + resume** → `execute()` → SIGKILL during step C → status stays `'running'` → `resume()` → A,B cached → C,D run → `'completed'`
4. **Double resume** → crash at C → resume crashes at D → second resume completes → `'completed'`

### Error paths
5. **Resume non-existent run** → `RunNotFoundError`
6. **Resume completed run** → `ResumeError`

### Edge cases
7. **Resume with `parallel()` branches** → cached branches return instantly, failed branches re-execute
8. **Resume with commit steps** → if working tree was already committed, `isClean` returns true, commit returns `null`
9. **Resume with zero completed steps** → all steps re-execute from scratch
10. **Resume where all steps cached but terminal status failed** → all steps memoized, sets `'completed'`

## References

### Internal

- Brainstorm: [`docs/brainstorms/2026-04-13-phase-11-resume-e2e-brainstorm.md`](../brainstorms/2026-04-13-phase-11-resume-e2e-brainstorm.md)
- `WorkflowExecutor` + `execute()`: `src/core/workflow.ts:64-67, 307-331`
- `runStepOnce()` memoization: `src/core/workflow.ts:273-305`
- `StateStore` interface: `src/state/state-store.ts:33-38`
- `RunState` status type: `src/state/state-store.ts:26-31`
- Error class convention: `StepError` at `src/core/workflow.ts:73-82`, `StateCorruptionError` at `src/state/state-store.ts:40-52`
- Existing crash/resume test (implicit): `tests/integration/core/workflow.test.ts:85-146`
- Existing parallel resume test (implicit): `tests/integration/core/parallel-mocked.test.ts:98-155`
- ClaudeRunner mocked integration pattern: `tests/integration/runners/claude/claude-mocked.test.ts`
- NDJSON fixtures: `tests/fixtures/claude/`
- Core barrel exports: `src/core/index.ts`

### External

- Inngest step memoization model: closest production equivalent to `runStepOnce` pattern
- Temporal deterministic replay: validates "replay workflow function, resolve completed activities from history" as a proven pattern
- AWS Step Functions / Azure Durable Functions: validate 3-state model as sufficient for synchronous single-process execution
