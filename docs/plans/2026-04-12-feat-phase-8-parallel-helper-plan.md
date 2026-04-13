---
title: Phase 8 — parallel() helper
type: feat
status: landed
date: 2026-04-12
deepened: 2026-04-12
---

# Phase 8 — `parallel()` helper

## Enhancement Summary

**Deepened:** 2026-04-12 — 9 research/review agents (TS reviewer, performance oracle, architecture strategist, simplicity reviewer, pattern specialist, spec flow analyzer, best practices researcher, repo analyst, security sentinel).

### Critical Bugs Found in Original Plan
1. **Sync callback throw bypasses settle-all** — `wrapSettled(fn(item))` doesn't catch sync throws before a promise is created
2. **Semaphore result population race** — `results[idx]` for items beyond initial limit set in `.then()` microtasks; `Promise.all` may see `undefined`
3. **`items[idx]!` non-null assertion** violates project rule 6
4. **Dead `allDone` code** in `runWithConcurrencyLimit` — constructed but never used

### Key Improvements
- Fix all 4 critical bugs · Write queue cleanup for memory leak · Nesting test · `Infinity` concurrency · Array snapshot · `unwrapSettled` dedup helper · Consistent error `.name` pattern · Defer `StepNameCollisionError` (YAGNI)

---

## Overview

Deterministic concurrency for the workflow DSL. A standalone `parallel()` function in `src/core/parallel.ts` that supports two forms: **heterogeneous** (different steps, tuple type inference) and **homogeneous** (same step template mapped over a list, optional concurrency cap). Both forms wrap the existing `run()` function — no new execution paths, no duplicated logic.

Source brainstorm: [`docs/brainstorms/2026-04-12-phase-8-parallel-helper-brainstorm.md`](../brainstorms/2026-04-12-phase-8-parallel-helper-brainstorm.md).

## Problem Statement / Motivation

Phases 1–7 built a complete sequential pipeline. Real multi-agent workflows need concurrency — run a planning agent and a research agent simultaneously, or fan out code reviews across N files. Without `parallel()`, users resort to raw `Promise.all` and lose error aggregation, resume support, and concurrency control.

## Proposed Solution

### DX target

```ts
// Heterogeneous — different steps, tuple inference
const [plan, code] = await parallel([run(PLAN_STEP), run(CODE_STEP)])

// Homogeneous — same step mapped over a list, with concurrency cap
const reviews = await parallel(
  files,
  (f) => run(REVIEW, { as: `review-${f}` }),
  { concurrency: 3 },
)
```

### Key decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Relationship to `run()` | Wrapper around existing promises | No duplication; all features work |
| API surface | Standalone free function | Keeps `RunFn` simple |
| Error semantics | Settle-all, then throw `ParallelError` | Maximizes memoized work |
| Branch naming | Require explicit `as` override | Predictable, resume-safe |
| Concurrency default | Unlimited; opt-in `{ concurrency: N }` | Most workflows are small |
| Type inference | Tuple via mapped types | Full per-branch type safety |

### Open question resolutions

**Q1: In-memory dedup in `run()`.** Don't add in Phase 8. Document same-name concurrent `run()` as undefined behavior.

**Q2: Callback invocation timing.** Without `concurrency`, all eager (same tick). With `concurrency: N`, lazy via pool pattern.

**Q3: Empty arrays.** `parallel([])` → `Promise<[]>`. `parallel([], fn)` → `Promise<[]>`.

## Technical Approach

### Prerequisite: fix `saveStep` race condition

`FileStateStore.saveStep()` does a read-modify-write cycle that is not concurrency-safe. **Fix:** per-runId cooperative async mutex with cleanup:

```ts
#writeQueue = new Map<string, Promise<void>>()

async saveStep(rid: RunId, entry: StepEntry): Promise<void> {
  const prev = this.#writeQueue.get(rid) ?? Promise.resolve()
  const next = prev.then(() => this.#doSaveStep(rid, entry))
  const swallowed = next.catch(() => {})
  this.#writeQueue.set(rid, swallowed)
  // Clean up when chain goes idle
  swallowed.then(() => {
    if (this.#writeQueue.get(rid) === swallowed) this.#writeQueue.delete(rid)
  })
  await next  // caller sees the real rejection
}
```

> **Research insight:** Promise-chain serializer is a well-established pattern (IndexedDB, Deno file-locks). The `.catch(() => {})` is critical to keep the chain alive. No Bun-specific microtask concerns. Cleanup prevents memory leak across runs.

### Step 1: `saveStep` write serialization (`src/state/state-store.ts`)

**Files:** `src/state/state-store.ts`, `tests/unit/state/state-store.test.ts`

**Tests:**
- "concurrent saveStep calls for the same runId do not lose entries"
- "concurrent saveStep calls for different runIds do not interfere"
- "write queue cleans up after chain goes idle"

### Step 2: Error types + helpers (`src/core/parallel.ts`)

```ts
interface SettledOk<T> { readonly status: 'ok'; readonly value: T }
interface SettledError { readonly status: 'error'; readonly error: unknown }
type SettledEntry<T = unknown> = SettledOk<T> | SettledError

class ParallelError extends Error {
  constructor(readonly settled: ReadonlyArray<SettledEntry>) {
    const failCount = settled.filter(s => s.status === 'error').length
    super(`${failCount} of ${settled.length} parallel branch(es) failed`)
    this.name = 'ParallelError'  // constructor assignment, consistent with StepError
  }
}
```

> **Research insights:** Custom `SettledEntry` (ok/error) is preferred over `PromiseSettledResult` (fulfilled/rejected) — matches Rust Result idiom. `StepNameCollisionError` removed from Phase 8 scope (YAGNI — never thrown). Set `.name` in constructor, not as class field, to match `StepError`/`ValidationError` pattern.

**Shared helpers:**

```ts
function isOk<T>(s: SettledEntry<T>): s is SettledOk<T> {
  return s.status === 'ok'
}

function unwrapSettled<T>(settled: ReadonlyArray<SettledEntry<T>>): T[] {
  if (settled.some(s => s.status === 'error')) throw new ParallelError(settled)
  return settled.map(s => (s as SettledOk<T>).value)
}
```

> **Research insight:** `unwrapSettled` deduplicates the throw-or-unwrap logic shared by both forms.

### Step 3: Type-level machinery

```ts
type AwaitedTuple<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: Awaited<T[K]>
}
```

> **Research insight:** `AwaitedTuple` is stable TS 4.0–6.0. The `[...T]` spread forces tuple inference **only for array literals**. Variable assignment widens to `Promise<unknown>[]` — document `as const` workaround in JSDoc.

### Step 4: `wrapSettled` — thunk-accepting (critical bug fix)

Original `wrapSettled(fn(item))` doesn't catch synchronous throws. **Fix:** accept a thunk:

```ts
async function wrapSettled<T>(thunk: () => Promise<T>): Promise<SettledEntry<T>> {
  try {
    return { status: 'ok', value: await thunk() }
  } catch (error) {
    return { status: 'error', error }
  }
}
```

The `try` wraps `thunk()` invocation, catching both sync throws and async rejections.

### Step 5: Heterogeneous implementation

```ts
async function parallelHeterogeneous<T extends readonly Promise<unknown>[]>(
  promises: [...T],
): Promise<AwaitedTuple<T>> {
  if (promises.length === 0) return [] as unknown as AwaitedTuple<T>

  const results = await Promise.allSettled(promises)
  const settled: SettledEntry[] = results.map(r =>
    r.status === 'fulfilled'
      ? { status: 'ok' as const, value: r.value }
      : { status: 'error' as const, error: r.reason },
  )
  return unwrapSettled(settled) as AwaitedTuple<T>
}
```

### Step 6: Homogeneous implementation

```ts
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

  const snapshot = Array.from(items)  // prevent mutation-during-iteration

  const isUnlimited = concurrency === undefined
    || concurrency === Number.POSITIVE_INFINITY
    || concurrency >= snapshot.length

  const settled = isUnlimited
    ? await Promise.all(snapshot.map(item => wrapSettled(() => fn(item))))
    : await runWithConcurrencyLimit(snapshot, fn, concurrency)

  return unwrapSettled(settled)
}
```

> **Research insights:** Accept `Infinity` as unlimited (original threw RangeError — surprising). `Array.from(items)` prevents mutation-during-iteration bugs in the concurrency-limited path.

### Step 7: Concurrency limiter (rewritten — fixes critical bugs)

Original had dead `allDone`, result population race, and `!` assertion. **Rewritten as pool pattern** (same approach as p-map):

```ts
async function runWithConcurrencyLimit<I, R>(
  items: readonly I[],
  fn: (item: I) => Promise<R>,
  limit: number,
): Promise<ReadonlyArray<SettledEntry<R>>> {
  const settled: SettledEntry<R>[] = new Array(items.length)
  const pool = new Set<Promise<void>>()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item === undefined) continue  // satisfies noUncheckedIndexedAccess

    const idx = i
    const task = wrapSettled(() => fn(item)).then(entry => {
      settled[idx] = entry
      pool.delete(task)
    })
    pool.add(task)

    if (pool.size >= limit) await Promise.race(pool)
  }

  await Promise.all(pool)
  return settled
}
```

> **Research insights:** Pool pattern (Set + Promise.race) is simpler and avoids the callback-driven semaphore's trampolining. No `!` assertions — guarded access satisfies `noUncheckedIndexedAccess`. At 100 items with `concurrency: 10`, pool holds at most 10 promises. No external deps needed (p-limit/p-map unnecessary for 2-20 branches).

### Step 8: Unified `parallel()` with overload dispatch

```ts
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
  return parallelHeterogeneous(
    first as readonly Promise<unknown>[],
  ) as Promise<unknown[]>
}
```

> **Research insight:** Reviewed splitting into two named exports. Decision: keep single `parallel()` overload — the DX target is established, the discrimination is clean, and the two forms are conceptually one operation. Add aliases in Phase 16 docs if needed.

### Step 9: Barrel exports (`src/core/index.ts`)

```ts
export type { SettledEntry, AwaitedTuple } from './parallel.ts'
export { parallel, ParallelError } from './parallel.ts'
```

**Changes from original:** Removed `StepNameCollisionError` (deferred). Added `AwaitedTuple` (needed for generic wrappers).

## Acceptance Criteria

### Functional
- [x] Heterogeneous form: N promises → typed tuple
- [x] Homogeneous form: items + callback → typed array
- [x] Concurrency cap (homogeneous only); `Infinity` = unlimited
- [x] Settle-all: all branches finish even when some fail
- [x] `ParallelError` with `.settled` array in input order
- [x] Sync callback throws captured by settle-all
- [x] Empty arrays → `[]` for both forms
- [x] Resume: cached branches skip, failed re-run
- [x] `concurrency < 1`, non-integer, 0 → `RangeError`
- [x] `saveStep` race fixed with per-runId mutex + cleanup
- [x] Nested `parallel()` works

### Non-Functional
- [x] `parallel.ts` ≤ 300 lines; functions ≤ 60 lines
- [x] No imports from `src/runners/` or `src/state/`
- [x] No `!` non-null assertions
- [x] `bun run check` green
- [x] `ParallelError.name` set in constructor

## Implementation Steps

| # | File(s) | Description | Tests |
|---|---|---|---|
| 1 | `src/state/state-store.ts` | `#writeQueue` mutex + cleanup | `tests/unit/state/state-store.test.ts` |
| 2 | `src/core/parallel.ts` | `ParallelError`, `SettledEntry`, `isOk`, `unwrapSettled`, `wrapSettled` | `tests/unit/core/parallel.test.ts` |
| 3 | `src/core/parallel.ts` | `AwaitedTuple` + overloaded signatures | type-level tests |
| 4 | `src/core/parallel.ts` | Heterogeneous impl | `tests/unit/core/parallel.test.ts` |
| 5 | `src/core/parallel.ts` | Homogeneous impl + array snapshot | `tests/unit/core/parallel.test.ts` |
| 6 | `src/core/parallel.ts` | Concurrency limiter (pool pattern) | `tests/unit/core/parallel.test.ts` |
| 7 | `src/core/index.ts` | Barrel exports | — |
| 8 | `tests/integration/core/parallel-mocked.test.ts` | Full round-trip integration | integration tests |
| 9 | `docs/plans/implementation-phases.md` | Mark Phase 8 as landed | — |

## Test Plan

### Unit: `tests/unit/core/parallel.test.ts`

**Heterogeneous:** 1) two promises → values in order, 2) single-element tuple, 3) empty → `[]`, 4) one fails → ParallelError with settled in order, 5) all fail, 6) settled has both ok and error entries.

**Homogeneous:** 7) maps callback → results in order, 8) single item, 9) empty → `[]`, 10) one mapped branch fails, 11) **sync throw from callback captured by settle-all** *(new)*.

**Concurrency:** 12) cap never exceeded (latch test), 13) concurrency 1 → sequential, 14) concurrency ≥ items → all concurrent, 15) queued items continue after branch fails, 16) **Infinity → all concurrent** *(new)*.

**Validation:** 17) concurrency 0 → RangeError, 18) negative → RangeError, 19) non-integer → RangeError.

**Nesting:** 20) **inner ParallelError in outer settled array** *(new)*.

**Types (compile-time):** 21) `AwaitedTuple<[Promise<string>, Promise<number>]>` = `[string, number]`, 22) `AwaitedTuple<[]>` = `[]`, 23) homogeneous return = `T[]`.

**Errors:** 24) message includes failure count, 25) settled is readonly, 26) name = "ParallelError".

### Unit: `tests/unit/state/state-store.test.ts`

27) concurrent saves same runId don't lose entries, 28) different runIds don't interfere, 29) **write queue cleanup** *(new)*.

### Integration: `tests/integration/core/parallel-mocked.test.ts`

30) heterogeneous persists both entries, 31) homogeneous creates 3 entries with as-override names, 32) resume skips completed + re-runs failed, 33) concurrency cap 2 over 5 items, 34) schema steps return Zod-parsed values.

## Risks

1. **`saveStep` mutex:** `.catch(() => {})` keeps chain alive; `#doSaveStep` re-reads from disk so failed prior write doesn't corrupt. Add implementation comment.
2. **Pool pattern edge cases:** pool size ≤ limit invariant; failed branches always release slot via `.then()`.
3. **Tuple inference:** Variable assignment degrades types. Document `as const` workaround.
4. **Duplicate step names:** Concurrent same-name `run()` calls race. Documented as undefined behavior. Future phase: in-memory dedup Map in `runStepOnce`.
5. **ParallelError catchability:** User can catch and continue workflow → status set to `completed` with partial failures. Intentional; document.
6. **Kill mid-parallel:** Uncached branches re-run on resume. No new logic needed.

## References

- Brainstorm: [`docs/brainstorms/2026-04-12-phase-8-parallel-helper-brainstorm.md`](../brainstorms/2026-04-12-phase-8-parallel-helper-brainstorm.md)
- `RunFn`: `src/core/workflow.ts:58` · `runStepOnce`: `src/core/workflow.ts:154-228`
- `FileStateStore.saveStep`: `src/state/state-store.ts:184-207`
- Test patterns: `tests/unit/core/workflow.test.ts` (`makeDeps()`) · `tests/helpers/type-assertions.ts`
- Error patterns: `StepError` `workflow.ts:73`, `SchemaValidationError` `schema.ts`, `ValidationError` `validators/`
- Barrel: `src/core/index.ts`
- External: p-map pool pattern (github.com/sindresorhus/p-map), TS variadic tuples (TS 4.0+)
