---
date: 2026-04-13
status: accepted
topic: Phase 11 — Resume end-to-end
---

# Phase 11 — Resume End-to-End

## What We're Building

A public `resume()` method on `WorkflowExecutor` that formalizes crash recovery into an explicit API. Today, resume already works *implicitly* — calling `execute()` with the same `runId` skips completed steps via memoization and `initRun()` is a no-op for existing runs. Phase 11 wraps this into a first-class DX with proper guards, status transitions, and error types.

**API shape:**

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

## Why This Approach

Resume is a method on `WorkflowExecutor` (not a standalone function) because:

1. **Symmetry** — `execute()` and `resume()` are sibling operations on the same workflow definition.
2. **Encapsulation** — the executor already holds the workflow function; no need to pass it again.
3. **Phase 12 readiness** — the CLI's `orch resume <id>` maps directly to `wf.resume({ runId })`.

The implicit mechanism is already tested and works. This phase adds explicit guards and status lifecycle management on top.

## Key Decisions

### 1. resume() is a method on WorkflowExecutor

Not a standalone function. Keeps the API surface small and symmetrical with `execute()`.

### 2. Throw on completed runs

`resume()` on a run with status `'completed'` throws an error. Resuming a finished run is always a programmer mistake — fail loudly.

### 3. Throw on missing runs

`resume()` on a non-existent `runId` throws `RunNotFoundError`. This is distinct from the completed-run error so Phase 12's CLI can display different messages.

### 4. Reset status to 'running' on entry

When `resume()` starts, it immediately sets status back to `'running'` before re-executing the workflow function. This keeps the state file honest during execution — querying mid-resume shows `'running'`, not stale `'crashed'`.

### 5. Same memoization mechanism

No changes to `runStepOnce()`. The existing name-keyed cache check is the resume mechanism. `resume()` just sets up the preconditions (validate state, reset status) then delegates to the same `fn(run)` call that `execute()` uses.

## Scope

### In scope

- `WorkflowExecutor.resume(deps)` method with `runId` in deps
- `ResumeError` (or similar) for completed/missing run guards
- Status transition: `crashed` -> `running` on resume entry
- Integration tests: FakeRunner crash+resume, ClaudeRunner+FakeProcessService crash+resume
- E2E (gated): 2-step workflow, step 1 real Claude succeeds, step 2 crashes, resume completes step 2 with real Claude

### Out of scope

- `resumeLatest()` or RunRegistry integration (Phase 12's CLI concern)
- Retry policies or automatic resume (future phase)
- Partial step re-execution (steps are atomic — crash means full re-run of that step)
- Changes to `runStepOnce()`, `StateStore`, or `RunRegistry` interfaces

## Error Types

| Error | When | Message pattern |
|---|---|---|
| `RunNotFoundError` | `runId` not in state store | `Cannot resume: run "r-..." not found` |
| `ResumeError` | Run exists but status is `'completed'` | `Cannot resume run "r-...": status is "completed", not "crashed"` |

Both should extend `Error` with descriptive `name` properties for Phase 12 CLI error handling.

## Status Lifecycle

```
execute()  -->  running  -->  completed
                   |
                   v
                crashed  -->  resume()  -->  running  -->  completed
                                               |
                                               v
                                            crashed (again)
```

## Implementation Sketch

`resume()` is thin — roughly:

1. `loadRun(runId)` — throw `RunNotFoundError` if undefined
2. Check `status` — throw `ResumeError` if `'completed'`
3. `setStatus(runId, 'running')` — reset from `'crashed'`
4. Create `run` closure (same as `execute`)
5. `fn(run)` — re-executes; memoization skips completed steps
6. `setStatus(runId, 'completed')` on success, `'crashed'` on error

Steps 4-6 are identical to `execute()`. The shared logic should be extracted into a private helper to avoid duplication.

## Test Plan

### Integration — FakeRunner crash+resume
- 4-step workflow: A, B succeed; C throws `StepError`; D never reached
- Assert state: `crashed`, steps A+B cached, C absent
- `wf.resume(sameDeps)` → A, B skipped (runner not called); C, D execute
- Assert state: `completed`, all 4 steps present

### Integration — ClaudeRunner + FakeProcessService crash+resume
- Same pattern but step C's failure comes from scripted NDJSON with error terminal event
- Resume scripts C's FakeProcessService to succeed on second invocation

### Integration — resume guards
- `resume()` on completed run → `ResumeError`
- `resume()` on non-existent runId → `RunNotFoundError`
- `resume()` on running run → decide (probably allow, since a "stuck" running state from a killed process is effectively crashed)

### E2E (gated, `RUN_REAL_CLAUDE=1`)
- 2-step workflow: step 1 = real Claude "Reply with exactly: OK", step 2 crashes
- Resume: step 1 cached, step 2 re-runs with real Claude
- Assert both steps in state.json, status `'completed'`

## Open Questions

*None — all questions resolved during brainstorming.*
