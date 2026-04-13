---
date: 2026-04-12
status: ready-for-plan
topic: Phase 8 — `parallel()` helper
---

# Phase 8 — `parallel()` helper brainstorm

## What we're building

Deterministic concurrency for the workflow DSL. A standalone `parallel()` function in `src/core/parallel.ts` that supports two forms:

**Heterogeneous** — different steps, different return types, tuple inference:

```ts
const [plan, code] = await parallel([
  run(PLAN_STEP),
  run(CODE_STEP),
]);
// plan: Plan, code: Code — full tuple inference
```

**Homogeneous** — same step template mapped over a list, with an opt-in concurrency cap:

```ts
const reviews = await parallel(
  files,
  (f) => run(REVIEW, { as: `review-${f}` }),
  { concurrency: 3 },
);
// reviews: ReviewResult[]
```

Both forms support resume: completed branches are skipped via the existing `run()` memoization; failed branches re-run from scratch.

## Why this approach

### Wrapper around `run()`, not a new execution path

`parallel()` does not duplicate any execution logic. The heterogeneous form wraps already-started `run()` promises (`Promise.allSettled` under the hood). The homogeneous form invokes the user-provided callback that calls `run()` internally. `run()` remains the single path through the executor, state store, and validation machinery.

This means every feature that works with sequential `run()` — typed returns, validators, memoization, crash resume — works identically inside `parallel()` with zero additional wiring.

### Standalone function, not a method on `run`

`parallel()` is a free function exported from `src/core/`. It doesn't need access to workflow internals — the heterogeneous form just wraps promises, and the homogeneous form receives `run` through the user's closure. This keeps `RunFn` a simple callable type and avoids coupling `parallel()` to workflow internals.

### Settle-all error semantics

When one branch fails, `parallel()` lets all remaining branches finish. This maximizes memoized work — on resume, completed branches skip instantly and only the failed branch re-runs. The alternative (fail-fast with subprocess killing) wastes work that could have been cached.

`parallel()` throws a `ParallelError` that exposes a `.settled` array with per-branch `{ status: 'ok', value }` or `{ status: 'error', error }` entries, mirroring `Promise.allSettled` semantics.

### Explicit branch names via `as`

For the homogeneous form, every branch must have an explicit name via `run(STEP, { as: '...' })`. No auto-naming from indices (fragile — list reordering breaks resume) or hashes (opaque in `state.json`). Duplicate names are detected eagerly and throw `StepNameCollisionError` before any branch starts.

For the heterogeneous form, each step already has its own name from `step.define()`.

### Unlimited concurrency by default

Most workflows run 2-5 parallel branches, not 100. The default is unlimited (all branches start immediately). The user opts into a cap with `{ concurrency: N }` on the homogeneous form only — the heterogeneous form's promises are already started by the time `parallel()` receives them.

### Tuple type inference for heterogeneous form

`parallel([run(A), run(B)])` returns `Promise<[TypeA, TypeB]>`, not `Promise<(TypeA | TypeB)[]>`. This uses TypeScript's mapped tuple types:

```ts
type AwaitedTuple<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: Awaited<T[K]>
};

function parallel<T extends readonly Promise<unknown>[]>(
  promises: [...T],
): Promise<AwaitedTuple<T>>;
```

Each destructured variable gets its correct type with zero annotations.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Relationship to `run()` | Wrapper around existing `run()` promises | No execution logic duplication; all existing features work |
| API surface | Standalone free function | Keeps `RunFn` simple; no workflow coupling |
| Error semantics | Settle-all, then throw `ParallelError` | Maximizes memoized work; cheapest resume |
| Branch naming (homogeneous) | Require explicit `as` override | Predictable, debuggable, resume-safe |
| Name collision | Eager detection, throw before execution | Prevents silent data corruption |
| Concurrency default | Unlimited; opt-in `{ concurrency: N }` | Most workflows are small; explicit throttling |
| Type inference (heterogeneous) | Tuple via mapped types | Full per-branch type safety |
| Concurrency cap scope | Homogeneous form only | Heterogeneous promises are already started |

## Open questions

1. **In-memory deduplication in `run()`.** The current `run()` checks the on-disk state store but has no in-memory lock for concurrent calls with the same step name. Two concurrent `run()` calls for the same name will both miss the cache and both start executing. For `parallel()`, this is a user error (calling the same step name twice), but we should decide whether to guard against it in `run()` itself with a `Map<StepName, Promise>` — or just document "don't do that" and let the duplicate-name detection in `parallel()` catch the homogeneous case.

2. **Homogeneous form: thunks or eager?** The current design has the homogeneous callback called eagerly (all at once) unless `concurrency` is set. When `concurrency` is set, `parallel()` must control callback invocation order. This means the homogeneous form inherently uses thunks internally (the callback is the thunk), even though the API looks eager. No user-facing decision needed, but the implementation must handle this.

3. **Empty array.** `parallel([])` should probably return `Promise<[]>` (no-op). `parallel([], fn)` returns `Promise<[]>`. Trivial but worth specifying.
