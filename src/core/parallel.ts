// ---------------------------------------------------------------------------
// parallel() — deterministic concurrency for the workflow DSL
// ---------------------------------------------------------------------------
//
// Two forms:
//   parallel([run(A), run(B)])        → heterogeneous tuple
//   parallel(items, fn, { concurrency }) → homogeneous mapped array
//
// Both settle all branches before throwing. Cached branches skip on resume.

import {
  currentParallelDepth,
  type ExecutionContext,
  executionContext,
} from './execution-context.ts'
import type { StepLifecycleEvent } from './workflow.ts'

// ---------------------------------------------------------------------------
// Settled types
// ---------------------------------------------------------------------------

export interface SettledOk<T> {
  readonly status: 'ok'
  readonly value: T
}

export interface SettledError {
  readonly status: 'error'
  readonly error: unknown
}

export type SettledEntry<T = unknown> = SettledOk<T> | SettledError

// ---------------------------------------------------------------------------
// ParallelError
// ---------------------------------------------------------------------------

export class ParallelError extends Error {
  constructor(readonly settled: ReadonlyArray<SettledEntry>) {
    const failCount = settled.filter((s) => s.status === 'error').length
    super(`${failCount} of ${settled.length} parallel branch(es) failed`)
    this.name = 'ParallelError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isOk<T>(s: SettledEntry<T>): s is SettledOk<T> {
  return s.status === 'ok'
}

/**
 * Unwrap a settled array: returns values if all ok, throws ParallelError otherwise.
 * Shared by both heterogeneous and homogeneous forms.
 */
function unwrapSettled<T>(settled: ReadonlyArray<SettledEntry<T>>): T[] {
  if (settled.some((s) => s.status === 'error')) throw new ParallelError(settled)
  return settled.map((s) => (s as SettledOk<T>).value)
}

/**
 * Wraps a thunk invocation as a settled entry. Accepts a thunk (not a promise)
 * so synchronous throws inside the callback are captured by the try/catch.
 */
async function wrapSettled<T>(thunk: () => Promise<T>): Promise<SettledEntry<T>> {
  try {
    return { status: 'ok', value: await thunk() }
  } catch (error) {
    return { status: 'error', error }
  }
}

// ---------------------------------------------------------------------------
// Type-level machinery
// ---------------------------------------------------------------------------

export type AwaitedTuple<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: Awaited<T[K]>
}

// ---------------------------------------------------------------------------
// Block-lifecycle helpers — emit step:parallel-start / step:parallel-complete
// around the body of either parallel() form so hosts (e.g. two-pane) can
// register and tear down a block-scoped rollup pane without snooping on
// step:parallel-branch-update counts.
// ---------------------------------------------------------------------------

function emitParallelStart(): number {
  const store = executionContext.getStore()
  const ref = store?.parallelBlockIdRef
  const emit = store?.emitLifecycle
  if (ref === undefined || emit === undefined) {
    // No host wired (tests calling parallel() directly without a workflow
    // executor). Skip block lifecycle but keep concurrency semantics intact.
    return -1
  }
  const blockId = ref.current
  ref.current += 1
  const event: StepLifecycleEvent = { type: 'step:parallel-start', blockId }
  emit(event)
  return blockId
}

function emitParallelComplete(blockId: number): void {
  if (blockId < 0) return
  const store = executionContext.getStore()
  const emit = store?.emitLifecycle
  if (emit === undefined) return
  const event: StepLifecycleEvent = { type: 'step:parallel-complete', blockId }
  emit(event)
}

// ---------------------------------------------------------------------------
// Heterogeneous implementation
// ---------------------------------------------------------------------------

async function parallelHeterogeneous<T extends readonly Promise<unknown>[]>(
  promises: [...T],
): Promise<AwaitedTuple<T>> {
  const blockId = emitParallelStart()
  try {
    if (promises.length === 0) return [] as unknown as AwaitedTuple<T>

    const results = await Promise.allSettled(promises)
    const settled: SettledEntry[] = results.map((r) =>
      r.status === 'fulfilled'
        ? { status: 'ok' as const, value: r.value }
        : { status: 'error' as const, error: r.reason },
    )
    return unwrapSettled(settled) as AwaitedTuple<T>
  } finally {
    emitParallelComplete(blockId)
  }
}

// ---------------------------------------------------------------------------
// Homogeneous implementation
// ---------------------------------------------------------------------------

async function parallelHomogeneous<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
  options?: { readonly concurrency?: number },
): Promise<R[]> {
  const concurrency = options?.concurrency
  if (concurrency !== undefined && concurrency !== Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        `concurrency must be a positive integer (or Infinity), got ${concurrency}`,
      )
    }
  }

  const blockId = emitParallelStart()
  try {
    if (items.length === 0) return []

    const snapshot = Array.from(items)
    const depth = currentParallelDepth() + 1
    // Each branch gets its own fresh store so setWorkflowCwd inside one branch
    // does not leak to siblings. The outer scope's workflowCwd is inherited at
    // branch start; the homogeneousBranch marker authorises setWorkflowCwd
    // (the hard guard rejects mutation in heterogeneous parallel scopes).
    // `emitLifecycle` and `parallelBlockIdRef` are inherited so nested
    // `parallel()` calls inside a branch still fire block-lifecycle events.
    const wrappedFn = (item: I): Promise<R> => {
      const outer = executionContext.getStore()
      // U3: propagate the subworkflow frame fields (`runFnRef`, `loggerRef`,
      // `subworkflowDepth`, `subworkflowPath`, `maxSubworkflowDepth`) so a
      // `runWorkflow` invocation inside a parallel branch sees the parent's
      // `run` closure (R7) and emits sub events through the parent's logger
      // (R17). `insideParallel` is always true inside a parallel branch by
      // definition — the sub frame entered from here will inherit it and
      // propagate to its descendants for R23 uniform suppression.
      const branchStore: ExecutionContext = {
        parallelDepth: depth,
        homogeneousBranch: true,
        insideParallel: true,
        ...(outer?.workflowCwd !== undefined ? { workflowCwd: outer.workflowCwd } : {}),
        ...(outer?.emitLifecycle !== undefined ? { emitLifecycle: outer.emitLifecycle } : {}),
        ...(outer?.parallelBlockIdRef !== undefined
          ? { parallelBlockIdRef: outer.parallelBlockIdRef }
          : {}),
        ...(outer?.runFnRef !== undefined ? { runFnRef: outer.runFnRef } : {}),
        ...(outer?.loggerRef !== undefined ? { loggerRef: outer.loggerRef } : {}),
        ...(outer?.subworkflowDepth !== undefined
          ? { subworkflowDepth: outer.subworkflowDepth }
          : {}),
        ...(outer?.subworkflowPath !== undefined ? { subworkflowPath: outer.subworkflowPath } : {}),
        ...(outer?.maxSubworkflowDepth !== undefined
          ? { maxSubworkflowDepth: outer.maxSubworkflowDepth }
          : {}),
      }
      return executionContext.run(branchStore, () => fn(item))
    }

    const isUnlimited =
      concurrency === undefined ||
      concurrency === Number.POSITIVE_INFINITY ||
      concurrency >= snapshot.length

    const settled = isUnlimited
      ? await Promise.all(snapshot.map((item) => wrapSettled(() => wrappedFn(item))))
      : await runWithConcurrencyLimit(snapshot, wrappedFn, concurrency)

    return unwrapSettled(settled)
  } finally {
    emitParallelComplete(blockId)
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter — pool pattern (same approach as p-map)
// ---------------------------------------------------------------------------

async function runWithConcurrencyLimit<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
  limit: number,
): Promise<ReadonlyArray<SettledEntry<R>>> {
  const settled: SettledEntry<R>[] = new Array(items.length)
  const pool = new Set<Promise<void>>()

  for (const [idx, item] of items.entries()) {
    const task = wrapSettled(() => fn(item)).then((entry) => {
      settled[idx] = entry
      pool.delete(task)
    })
    pool.add(task)

    if (pool.size >= limit) await Promise.race(pool)
  }

  await Promise.all(pool)
  return settled
}

// ---------------------------------------------------------------------------
// Unified parallel() with overload dispatch
// ---------------------------------------------------------------------------

export async function parallel<T extends readonly Promise<unknown>[]>(
  promises: [...T],
): Promise<AwaitedTuple<T>>

export async function parallel<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
  options?: { readonly concurrency?: number },
): Promise<R[]>

export async function parallel(
  first: readonly unknown[],
  fn?: (item: unknown) => Promise<unknown>,
  options?: { readonly concurrency?: number },
): Promise<unknown[]> {
  if (fn !== undefined) return parallelHomogeneous(first, fn, options)
  return parallelHeterogeneous(first as Promise<unknown>[]) as Promise<unknown[]>
}
