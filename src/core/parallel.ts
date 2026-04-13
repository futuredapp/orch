// ---------------------------------------------------------------------------
// parallel() — deterministic concurrency for the workflow DSL
// ---------------------------------------------------------------------------
//
// Two forms:
//   parallel([run(A), run(B)])        → heterogeneous tuple
//   parallel(items, fn, { concurrency }) → homogeneous mapped array
//
// Both settle all branches before throwing. Cached branches skip on resume.

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
// Heterogeneous implementation
// ---------------------------------------------------------------------------

async function parallelHeterogeneous<T extends readonly Promise<unknown>[]>(
  promises: [...T],
): Promise<AwaitedTuple<T>> {
  if (promises.length === 0) return [] as unknown as AwaitedTuple<T>

  const results = await Promise.allSettled(promises)
  const settled: SettledEntry[] = results.map((r) =>
    r.status === 'fulfilled'
      ? { status: 'ok' as const, value: r.value }
      : { status: 'error' as const, error: r.reason },
  )
  return unwrapSettled(settled) as AwaitedTuple<T>
}

// ---------------------------------------------------------------------------
// Homogeneous implementation
// ---------------------------------------------------------------------------

async function parallelHomogeneous<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
  options?: { readonly concurrency?: number },
): Promise<R[]> {
  if (items.length === 0) return []

  const concurrency = options?.concurrency
  if (concurrency !== undefined && concurrency !== Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        `concurrency must be a positive integer (or Infinity), got ${concurrency}`,
      )
    }
  }

  const snapshot = Array.from(items)

  const isUnlimited =
    concurrency === undefined ||
    concurrency === Number.POSITIVE_INFINITY ||
    concurrency >= snapshot.length

  const settled = isUnlimited
    ? await Promise.all(snapshot.map((item) => wrapSettled(() => fn(item))))
    : await runWithConcurrencyLimit(snapshot, fn, concurrency)

  return unwrapSettled(settled)
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
