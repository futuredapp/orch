import { AsyncLocalStorage } from 'node:async_hooks'
import type { Path } from './types.ts'

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

export interface ExecutionContext {
  readonly parallelDepth: number
  // Mutable so createWorktree({ enter: true }) can update the active store
  // via setWorkflowCwd; readers go through currentCwd(fallback). The rest of
  // the interface stays readonly.
  workflowCwd?: Path
  readonly homogeneousBranch?: true
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
