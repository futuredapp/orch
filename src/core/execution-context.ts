import { AsyncLocalStorage } from 'node:async_hooks'

// ---------------------------------------------------------------------------
// ExecutionContext — AsyncLocalStorage for workflow execution state
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  readonly parallelDepth: number
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>()

/**
 * Returns the current parallel depth (0 = not inside parallel()).
 * Safe to call outside any context — returns 0.
 */
export function currentParallelDepth(): number {
  return executionContext.getStore()?.parallelDepth ?? 0
}
