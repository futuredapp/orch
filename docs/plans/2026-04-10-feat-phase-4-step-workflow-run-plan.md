---
title: Phase 4 — step.define + workflow + run + memoization
type: feat
status: draft
date: 2026-04-10
phase: 4
deepened: 2026-04-10
relates-to:
  - docs/plans/implementation-phases.md
  - docs/plans/2026-04-10-feat-phase-3-state-store-run-ids-plan.md
---

# Phase 4 — `step.define` + `workflow` + `run` + memoization

## Enhancement Summary

**Deepened on:** 2026-04-10 | **Agents used:** 11 (architecture, typescript, performance, simplicity, patterns, spec-flow, best-practices, framework-docs, repo-research, security, inngest/temporal)

### Critical Issues Found
1. **`runRunner` never populates `structuredOutput`** — `run()` closure must call `extractStructuredOutput()` directly
2. **`initRun` algorithm contradicts idempotency test** — must load-then-skip, not blind write
3. **`FakeRunner.invocationCount` is cumulative** — resume test must check count=1, not count=0

### Key Improvements
1. In-memory RunState cache recommendation (Phase 8 readiness)
2. Tightened types: `JsonValue` for extraContext, `StepName` in StepError, 128-char length cap
3. Removed untested `extraArgs` from RunOverrides (YAGNI)
4. Added `setStatus` failure handling in execute() catch block
5. Confirmed Inngest-style replay is the proven industry pattern

---

## Overview

Land the core DSL — the three primitives users write workflows against. A workflow is a plain async function. Steps are reusable named constants. `run(STEP)` invokes a step, memoizes the result by name, and returns the cached value on resume. All tests use `FakeRunner` — no real CLIs yet.

This follows the **Inngest step.run() model**: re-execute the entire workflow function top-to-bottom; each `run()` checks a state map by name; cached results return immediately, uncached steps execute fresh. Both Inngest and Temporal confirm this pattern. Our Zod validation on `loadRun` is strictly better than both systems' plain JSON serialization.

## Problem statement / motivation

Phases 1-3 shipped the I/O seams (`ProcessService`), the agent abstraction (`Runner` + `runRunner`), and the persistence layer (`StateStore` + `RunId`). But there's no way to *compose* these into a workflow. Phase 4 fills that gap.

## Prerequisites (from Phases 1-3)

| Artifact | Location | Status |
|---|---|---|
| `Runner` interface | `src/runners/types.ts:57-63` | shipped |
| `RunnerContext` | `src/runners/types.ts:8-13` | shipped |
| `runRunner()` executor | `src/runners/execute.ts:14-21` | shipped |
| `RunnerResult` | `src/runners/execute.ts:6-12` | shipped |
| `FakeRunner` | `src/runners/fake/fake-runner.ts` | shipped |
| `StateStore` interface | `src/state/state-store.ts:21-24` | shipped |
| `FileStateStore` | `src/state/state-store.ts:55` | shipped |
| `RunId` + `generateRunId()` | `src/state/run-id.ts` | shipped |
| `ProcessService` / `FakeProcessService` | `src/services/process/` | shipped |
| `Clock` + `FakeClock` / `FsService` + `FakeFsService` | `src/services/` | shipped |
| `Path` branded type | `src/services/types.ts:3` | shipped |

## Proposed solution

### File tree

```
src/core/
  types.ts            # StepName branded type; re-export Path, RunId
  step.ts             # step.define(name, config) → Step
  workflow.ts          # workflow(name, fn) → WorkflowExecutor; run() + assemblePrompt()
  index.ts            # public barrel
tests/unit/core/       step.test.ts, workflow.test.ts
tests/integration/core/ workflow.test.ts
```

### StateStore interface extension (prerequisite)

```ts
export interface StateStore {
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
  initRun(runId: RunId): Promise<void>         // NEW
  setStatus(runId: RunId, status: RunState['status']): Promise<void>  // NEW
}
```

**`initRun` algorithm (CORRECTED — must be idempotent):**
1. `loadRun(runId)` — if state already exists, **return without modification**
2. `fs.mkdir(dir, { recursive: true })`
3. Write `{ schemaVersion: 1, id: runId, status: 'running', steps: {} }` via atomic tmp+rename

> **Why load-then-skip?** The original algorithm described a blind write of `{ steps: {} }` which would destroy existing steps on resume. Test 12 requires: `initRun + saveStep + initRun → steps still present`.

**`setStatus` algorithm:** `loadRun(runId)` — throw if undefined; write `{ ...existing, status }` via atomic tmp+rename.

**TOCTOU note:** `saveStep` does load-then-write (non-atomic). Safe for Phase 4 (sequential), but Phase 8 `parallel()` needs locking or CAS. Add a `// TODO(phase-8)` comment.

### Public type signatures

#### `src/core/types.ts`

```ts
/** Branded step name: /^[a-z0-9][a-z0-9-]*$/, max 128 chars. */
export type StepName = string & { readonly __brand: 'StepName' }

/** Validates and casts. Throws on invalid format or length > 128. */
export function stepName(s: string): StepName

// Pattern is an implementation detail — NOT exported from barrel.
// Tests validate behavior (throws on bad input), not the regex itself.

// Re-exports from barrels (not internal files — respects single-barrel rule)
export type { Path } from '../services/index.ts'
export { path } from '../services/index.ts'
export type { RunId } from '../state/index.ts'
export { runId, generateRunId } from '../state/index.ts'
```

**Security note:** 128-char cap prevents filesystem path length issues and state.json key bloat.

> **Why not relocate `Path` here?** `Path` is a services-layer concern. Re-exporting avoids a circular dependency (services shouldn't import from core). Canonical definition stays in services.

#### `src/core/step.ts`

```ts
import type { Runner } from '../runners/index.ts'
import type { StepName } from './types.ts'

export interface StepConfig {
  readonly agent: Runner
  readonly prompt?: string
}

export interface Step {
  readonly name: StepName
  readonly config: StepConfig
}

export const step = {
  define(name: string, config: StepConfig): Step {
    return Object.freeze({ name: stepName(name), config })
  },
} as const
```

**Why `step.define()` not `defineStep()`?** Reads like prose, namespaces future additions (`step.from()`, `step.extend()`). Confirmed as idiomatic modern TypeScript by research agents. `as const` signals intent; harmless even if it doesn't narrow function values.

#### `src/core/workflow.ts`

```ts
import type { Clock, ProcessService } from '../services/index.ts'
import type { RunId, Path } from './types.ts'
import type { StateStore, StepEntry } from '../state/index.ts'
import type { Step } from './step.ts'
import { runRunner, type RunnerContext } from '../runners/index.ts'

export type JsonValue =
  | string | number | boolean | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export interface RunOverrides {
  readonly as?: string
  readonly prompt?: string
  readonly extraContext?: JsonValue    // NOT unknown — compile-time serialization safety
  readonly extraPrompt?: string
}
// extraArgs removed (YAGNI — no Phase 4 test exercises it; add in Phase 5 if needed)

export interface WorkflowDeps {
  readonly stateStore: StateStore
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly cwd: Path
}

export type RunFn = (step: Step, overrides?: RunOverrides) => Promise<unknown>

export interface WorkflowExecutor {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
}

export function workflow(
  name: string,
  fn: (run: RunFn) => Promise<void>,
): WorkflowExecutor
```

**Why not generic `RunFn<T>` now?** Would cascade generics through `Step<T>` and the entire API. Phase 7 refactor is contained. Don't design for hypothetical future requirements.

**`execute()` algorithm (CORRECTED — handles setStatus failure):**
1. `deps.stateStore.initRun(deps.runId)` — no-ops if exists
2. Build `run` closure (captures `deps`)
3. Call `fn(run)` inside try-catch
4. Success: `setStatus(runId, 'completed')`
5. Error: try `setStatus(runId, 'crashed')` — if setStatus itself throws (e.g. initRun failed), **swallow** it; re-throw original error

> **Why swallow setStatus failure?** If initRun throws (disk full), the catch tries setStatus on a non-existent run, which throws. Without the inner try-catch, the original error is lost.

**`run()` closure algorithm (CORRECTED — calls extractStructuredOutput):**
1. Resolve key: `overrides?.as ?? step.name`; validate as `StepName`
2. `deps.stateStore.loadRun(deps.runId)` — `// TODO(phase-8): cache in memory`
3. If `state.steps[key]` exists → return cached value
4. Assemble prompt; build `RunnerContext: { cwd: deps.cwd, env: {}, prompt, extraArgs: [] }`
5. `const result = await runRunner(step.config.agent, ctx, deps)`
6. If `result.finalEvent.type === 'error'` → throw `StepError`
7. **`const value = step.config.agent.extractStructuredOutput(result.finalEvent)`** ← CRITICAL FIX
8. Build `StepEntry`, `saveStep`, return value

> **Why call extractStructuredOutput directly?** `runRunner()` at `execute.ts:54` hardcodes `structuredOutput: undefined`. Calling `extractStructuredOutput` in the closure keeps `runRunner` unchanged (no Phase 2 modifications).

**Prompt assembly:**
```ts
function assemblePrompt(
  defaultPrompt: string | undefined,
  overrides: RunOverrides | undefined,
): string {
  const base = overrides?.prompt ?? defaultPrompt ?? ''
  const parts = [base]
  if (overrides?.extraContext !== undefined) {
    parts.push(JSON.stringify(overrides.extraContext, null, 2))
  }
  if (overrides?.extraPrompt) parts.push(overrides.extraPrompt)
  return parts.filter(Boolean).join('\n\n')
}
```

**Empty prompt contract:** Returns `''` if all inputs undefined. Runners must accept empty prompts gracefully — if a future runner rejects them, add validation in that runner's `buildCommand`.

**StepError (CORRECTED — branded stepName):**
```ts
export class StepError extends Error {
  constructor(
    readonly stepName: StepName,   // branded, not plain string
    readonly exitCode: number,
    message: string,
  ) {
    super(`Step "${stepName}" failed (exit ${exitCode}): ${message}`)
    this.name = 'StepError'
  }
}
```

#### `src/core/index.ts`

```ts
export type { Step, StepConfig } from './step.ts'
export { step } from './step.ts'
export type { RunFn, RunOverrides, WorkflowDeps, WorkflowExecutor, JsonValue } from './workflow.ts'
export { workflow, StepError } from './workflow.ts'
export type { StepName, Path, RunId } from './types.ts'
export { stepName, path, runId, generateRunId } from './types.ts'
// STEP_NAME_PATTERN intentionally NOT exported — implementation detail
```

### Things deliberately NOT in this phase

| Deferred | Ships in |
|---|---|
| `run.custom(name, fn)` | Phase 11+ |
| `returns: schema(zod)` / `RunFn<T>` / `Step<T>` | Phase 7 |
| `validate:` key | Phase 6 |
| `skill:` key | Phase 5 |
| `parallel()` | Phase 8 |
| `commit()` | Phase 10 |
| `workflow.resume(runId)` | Phase 11 |
| `extraArgs` in RunOverrides | Phase 5 |
| In-memory RunState cache | Phase 8 |
| Retry/backoff on transient failures | TBD |
| Workflow name validation | TBD |

### Edge cases

| Case | Behavior |
|---|---|
| Duplicate memoization key | Returns cached value — by design |
| Invalid step name (empty, uppercase, slashes, >128 chars) | `stepName()` throws at define time |
| Invalid `as` value | `stepName()` throws at run time |
| Crash before any step | `initRun` already persisted empty running state |
| Crash mid-step | Not cached → re-runs on resume (Inngest-style atomic steps) |
| Runner error event | `StepError` → `crashed` → re-throw |
| Empty prompt (all undefined) | `''` passed to runner — runners must accept |
| Non-serializable extraContext | Prevented at compile time by `JsonValue` type |
| `noUncheckedIndexedAccess` on steps[key] | `undefined` = cache miss → execute |
| Non-StepError thrown | Wrapper catches, sets `crashed`, re-throws |
| Same Step twice without `as:` | Cache hit — use `as:` for independent runs |
| `initRun` on existing runId | Idempotent — existing steps preserved |
| `setStatus` fails in catch | Swallowed — original error re-thrown |
| Concurrent same runId | **Undefined behavior** — document |
| `run()` called after workflow returns | **Undefined behavior** — stale state |
| `saveStep` fails (disk full) | Caught by wrapper → `crashed` if possible |

### Resume semantics (Phase 4 scope)

Implicit resume by re-executing with same `runId`. Tests verify:
1. Workflow crashes at step 3 (FakeRunner scripted to fail)
2. New `execute()` call with same `runId`
3. Steps 1-2: invocation count stays at 1 total (not 0 — `FakeRunner.invocationCount` is cumulative)
4. Step 3: re-runs successfully

## Test plan

### Unit — `tests/unit/core/step.test.ts` (5 tests)

| # | Test name |
|---|---|
| 1 | `step.define returns a frozen Step with the given name and config` |
| 2 | `step.define validates the name as a StepName` |
| 3 | `step.define throws for an empty name` |
| 4 | `step.define throws for a name with uppercase letters` |
| 5 | `step.define throws for a name with slashes` |

### Unit — `tests/unit/core/workflow.test.ts` (10 tests)

| # | Test name |
|---|---|
| 1 | `run executes a step and returns its value via extractStructuredOutput` |
| 2 | `run memoizes by step name — second invocation returns cached value without re-running` |
| 3 | `run uses overrides.as as the memoization key instead of step name` |
| 4 | `overrides at call site do not change the memoization key when as is absent` |
| 5 | `run assembles prompt from config default, overrides.prompt, extraContext, and extraPrompt` |
| 6 | `run throws StepError when runner returns an error terminal event` |
| 7 | `workflow sets status to completed on success` |
| 8 | `workflow sets status to crashed on step failure` |
| 9 | `resume skips completed steps and re-runs the failed step` |
| 10 | `initRun persists empty running state before any steps` |

### Unit — `tests/unit/state/state-store.test.ts` additions (5 tests)

| # | Test name |
|---|---|
| 11 | `initRun creates an empty running state` |
| 12 | `initRun is idempotent — calling twice does not clear existing steps` |
| 13 | `setStatus transitions status from running to completed` |
| 14 | `setStatus transitions status from running to crashed` |
| 15 | `setStatus throws for a non-existent run` |

### Integration — `tests/integration/core/workflow.test.ts` (3 tests)

| # | Test name |
|---|---|
| 16 | `four-step fake workflow runs end-to-end and persists all steps in state.json` |
| 17 | `four-step workflow with crash at step 3, then resume completes all steps` |
| 18 | `state.json matches RunState schema after a complete workflow run` |

**Total: 23 tests** (5 step + 10 workflow + 5 state-store + 3 integration)

### Test implementation notes
- Test 1: verify `extractStructuredOutput` is called, not `result.structuredOutput`
- Test 9: use separate FakeRunner instances per execution, or verify total count=1 (not 0)
- No `mock.module` anywhere — compose `FakeRunner` + `FakeProcessService` + `FakeClock` + `FileStateStore` + `FakeFsService`

## Implementation order

1. **Extend StateStore** — `initRun` (load-then-skip) + `setStatus`; 5 unit tests
2. **`src/core/types.ts`** — `StepName` (128-char cap) + re-exports from barrels
3. **`src/core/step.ts`** — `step.define()`; 5 unit tests
4. **`src/core/workflow.ts`** — `workflow()`, `run()` (calling `extractStructuredOutput`), `assemblePrompt()`, `StepError`, `JsonValue`; 10 unit tests
5. **`src/core/index.ts`** — barrel (without `STEP_NAME_PATTERN`)
6. **Update `src/state/index.ts`** — export new methods
7. **Integration tests** — 3 tests against real temp dirs
8. **`bun run check`** — green gate

## Acceptance criteria

- [x] `step.define('plan', { agent: fakeRunner })` returns a frozen `Step` with validated `StepName`
- [x] `stepName()` rejects names longer than 128 characters
- [x] `workflow('test', fn).execute(deps)` runs the workflow function and persists state
- [x] `run(STEP)` invokes `runRunner`, calls `extractStructuredOutput`, returns value
- [x] `run(STEP)` returns cached value on second call — invocation count stays at 1
- [x] `run(STEP, { as: 'custom' })` uses `'custom'` as the memoization key
- [x] Overrides without `as` do NOT change the memoization key
- [x] Crash → `crashed`; re-execute same runId → completed steps skip, failed step re-runs
- [x] `initRun` is idempotent — calling twice does not clear existing steps
- [x] `setStatus` failure in catch block does not mask the original error
- [x] 4-step integration test passes against real `BunFsService` temp dir
- [x] `state.json` validates against `RunStateSchema`
- [x] No concrete runner imports in `src/core/`
- [x] No `mock.module` / `vi.mock` / `jest.mock` in core tests
- [x] All files ≤ 300 lines, all functions ≤ 60 lines
- [x] `bun run check` green
- [x] `STEP_NAME_PATTERN` NOT exported; `extraContext` typed as `JsonValue`

## References

- Brainstorm: `docs/brainstorms/2026-04-08-claude-orchestrator-brainstorm.md:36-143`
- Getting-started API: `docs/getting-started.md:73-179`
- Phase 4 roadmap spec: `docs/plans/implementation-phases.md:118-132`
- Phase 3 plan: `docs/plans/2026-04-10-feat-phase-3-state-store-run-ids-plan.md`
- Inngest step.run(): re-execute + skip cached — same model as this design
- Temporal replay: event-sourced history — heavier, confirms the "skip completed" pattern
