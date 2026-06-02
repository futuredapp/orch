import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionLogger } from '../observability/index.ts'
import type { Path } from './types.ts'
// Type-only import — `workflow.ts` already depends on this file at runtime,
// so a value-level import would create a runtime cycle. Erased after compile.
import type { RunFn, StepLifecycleEvent } from './workflow.ts'

// ---------------------------------------------------------------------------
// ExecutionContext — AsyncLocalStorage for workflow execution state
// ---------------------------------------------------------------------------
//
// `parallelDepth` and `homogeneousBranch` are immutable per-scope markers;
// `workflowCwd` is the one mutable field — `setWorkflowCwd` writes through to
// the active store object so cwd changes survive across awaits inside the
// same scope. A homogeneous parallel branch creates its own store so each
// branch sees the outer `workflowCwd` at start and may diverge without
// leaking back to siblings.
//
// `emitLifecycle` and `parallelBlockIdRef` carry just enough of the workflow
// host wiring into the ALS scope that `parallel()` can fire
// `step:parallel-start` / `step:parallel-complete` events without taking a
// direct dependency on the workflow executor or its WorkflowDeps. The root
// store sets both; each homogeneous branch inherits them so nested parallel
// calls keep firing.

/** Mutable counter shared across the run so each `parallel()` invocation gets
 *  a unique, deterministic block id. */
export interface ParallelBlockIdRef {
  current: number
}

export interface ExecutionContext {
  readonly parallelDepth: number
  // Mutable so createWorktree({ enter: true }) can update the active store
  // via setWorkflowCwd; readers go through currentCwd(fallback). The rest of
  // the interface stays readonly.
  workflowCwd?: Path
  readonly homogeneousBranch?: true
  readonly emitLifecycle?: (event: StepLifecycleEvent) => void
  readonly parallelBlockIdRef?: ParallelBlockIdRef
  // Subworkflow frame fields (U3). Undefined at the root frame, populated
  // on each `runWorkflow` entry. `subworkflowDepth` defaults to 0 (root);
  // `subworkflowPath` defaults to [] (root). Persisted step entries spell
  // the same chain as `subPath`; keep the ALS name explicit to distinguish
  // execution-frame state from stored step metadata. `insideParallel` is set when
  // a sub is entered from a parent frame inside a `parallel()` branch and
  // propagates to all descendants (R23 — uniform suppression across the
  // sub-of-sub subtree).
  readonly subworkflowDepth?: number
  readonly subworkflowPath?: readonly string[]
  readonly insideParallel?: true
  // Opaque per-invocation token minted by `runWorkflow`. Two distinct
  // `runWorkflow` calls (even of the same sub) produce different ids; U4's
  // R20 collision detector compares this against the existing entry's
  // `subCallId` to catch the "same sub invoked twice" case where the
  // sub-path alone matches.
  readonly subCallId?: string
  // Populated at workflow-root construction in `executeWorkflowFn`. Read by
  // `runWorkflow` to pass the parent's `run` closure into the sub body (R7
  // inline-equivalence) and to append `subworkflow:enter`/`subworkflow:exit`
  // records to `lifecycle.ndjson` (R17). Both fields are optional so the
  // root frame can populate them in one literal alongside the existing
  // fields without breaking sites that construct an ExecutionContext
  // directly in tests.
  readonly runFnRef?: RunFn
  readonly loggerRef?: SessionLogger
  // Snapshot of `WorkflowDeps.maxSubworkflowDepth` taken at workflow-root
  // construction so `runWorkflow`'s depth guard is per-execution (no
  // process-globals, no test pollution, no concurrent-execution race).
  readonly maxSubworkflowDepth?: number
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>()

/**
 * Returns the current parallel depth (0 = not inside parallel()).
 * Safe to call outside any context — returns 0.
 */
export function currentParallelDepth(): number {
  return executionContext.getStore()?.parallelDepth ?? 0
}

/**
 * Returns the current subworkflow depth (0 = at the workflow root, not inside
 * any `runWorkflow` frame). Safe to call outside any context — returns 0.
 */
export function currentSubworkflowDepth(): number {
  return executionContext.getStore()?.subworkflowDepth ?? 0
}

/**
 * Returns the current sub-path: the chain of sub names enclosing the active
 * step, deepest last. Empty at the root. Safe to call outside any context —
 * returns the empty array.
 */
export function currentSubworkflowPath(): readonly string[] {
  return executionContext.getStore()?.subworkflowPath ?? []
}

/**
 * Returns true when the active frame is inside a `parallel()` branch OR is a
 * descendant of a sub entered from inside a parallel branch. The latter
 * propagation is required for R23/AE13 — boundary rendering is suppressed
 * uniformly across the whole sub-of-sub subtree, not just the first level
 * below the parallel block.
 */
export function isInsideParallel(): boolean {
  const store = executionContext.getStore()
  if (store === undefined) return false
  return store.insideParallel === true || store.parallelDepth > 0
}

/**
 * Reads the active workflow cwd. Returns the fallback when no store is active
 * or when `workflowCwd` has not been set in the current scope.
 */
export function currentCwd(fallback: Path): Path {
  return executionContext.getStore()?.workflowCwd ?? fallback
}

/**
 * Sets the active workflow cwd by mutating the current ALS store. Subsequent
 * `currentCwd()` reads in the same scope (and in nested awaits) see the new
 * value.
 *
 * Throws if invoked outside a homogeneous-branch scope while
 * `parallelDepth > 0` — heterogeneous parallel branches share the outer
 * store, and silently corrupting cwd across siblings is a higher-severity
 * failure class than a missing roll-up event. The hard guard forces callers
 * inside `parallel()` to use the homogeneous form.
 */
export function setWorkflowCwd(path: Path): void {
  const store = executionContext.getStore()
  if (store === undefined) {
    throw new Error('setWorkflowCwd called outside an active executionContext scope')
  }
  if (store.parallelDepth > 0 && store.homogeneousBranch !== true) {
    throw new Error('createWorktree({ enter: true }) requires the homogeneous parallel form')
  }
  store.workflowCwd = path
}
