# Plan 011: Serialize `initRun`/`setArgs`/`setStatus` through the write-queue

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 011 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/state/state-store.ts`
> On any change, compare the "Current state" excerpts against the live code; on a
> mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (concurrency)
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`saveStep` serializes writes per-run through a `#writeQueue` **specifically to
prevent read-modify-write races** when parallel branches persist at the same time.
But `initRun`, `setArgs`, and `setStatus` do their own `loadRun()` +
`#atomicWrite()` **outside** that queue. On the crash/teardown path, `setStatus`
reads the state, an in-flight queued `saveStep` for a still-running parallel branch
completes its atomic rename, and `setStatus`'s later rename overwrites it with a
snapshot missing that step — or the branch write clobbers the status. The result is
a silently lost step or a run stuck in `running`, corrupting exactly the state
crash-resume relies on.

## Current state

`src/state/state-store.ts`:

- `saveStep` (`:419-432`) goes through the queue:
  ```ts
  async saveStep(rid: RunId, entry: StepEntry): Promise<void> {
    const prev = this.#writeQueue.get(rid) ?? Promise.resolve()
    const next = prev.then(() => this.#doSaveStep(rid, entry))
    const swallowed = next.catch(() => {})
    this.#writeQueue.set(rid, swallowed)
    swallowed.then(() => {
      if (this.#writeQueue.get(rid) === swallowed) this.#writeQueue.delete(rid)
    })
    await next
  }
  ```
- `initRun` (`:465-490`), `setArgs` (`:492-505`), `setStatus` (`:507-521`) each do
  `const existing = await this.loadRun(rid)` then `await this.#atomicWrite(...)`
  directly — **not** through `#writeQueue`.
- `#doSaveStep` (`:434-461`) is the queued body for `saveStep`.
- The failure-path caller is `src/core/workflow.ts` (the run-status catch calls
  `setStatus`), and parallel branches persist via `saveStep` concurrently.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| State tests | `bun test tests/unit/state/state-store.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/state/state-store.ts` — extract the enqueue-and-serialize helper; route all
  four mutators through it.
- `tests/unit/state/state-store.test.ts` — add a concurrency ordering test.

**Out of scope (do NOT touch):**
- Callers in `src/core/workflow.ts` — behavior stays the same, only ordering is
  added.
- `#atomicWrite` and `#doSaveStep` internals.

## Steps

### Step 1: Extract the enqueue helper

Factor the queue mechanics out of `saveStep` into a private method, e.g.:

```ts
#enqueueWrite<T>(rid: RunId, op: () => Promise<T>): Promise<T> {
  const prev = this.#writeQueue.get(rid) ?? Promise.resolve()
  const next = prev.then(op)
  const swallowed = next.catch(() => {})
  this.#writeQueue.set(rid, swallowed)
  swallowed.then(() => {
    if (this.#writeQueue.get(rid) === swallowed) this.#writeQueue.delete(rid)
  })
  return next
}
```

Rewrite `saveStep` to `return this.#enqueueWrite(rid, () => this.#doSaveStep(rid, entry))`.
Keep its public signature and error-propagation contract identical (the caller
still awaits the un-swallowed promise).

**Verify**: `bun test tests/unit/state/state-store.test.ts` → all pass (existing
`saveStep` behavior unchanged).

### Step 2: Route the three other mutators through the queue

Wrap the *bodies* of `initRun`, `setArgs`, and `setStatus` in
`this.#enqueueWrite(rid, async () => { ...existing body... })` and `return`/`await`
it. The existing `loadRun` + `#atomicWrite` (and the "does not exist" throws for
`setArgs`/`setStatus`) move inside the `op` closure so they run serialized with any
pending `saveStep` for the same run. Preserve every existing throw and early-return.

**Verify**: `bun run typecheck` → exit 0; `bun test tests/unit/state/state-store.test.ts`
→ all pass.

### Step 3: Add a concurrency regression test

In `tests/unit/state/state-store.test.ts`, add a test that fires a `saveStep` and a
`setStatus` for the same run concurrently (`await Promise.all([...])`) and asserts
the final loaded state contains BOTH the saved step AND the new status — i.e. one
did not clobber the other. Mirror the file's existing arrange/act/assert and its
fake-fs setup. Full-sentence name, e.g.
`it('does not drop a concurrent saveStep when setStatus runs at the same time', ...)`.

If the fake `FsService` used in these tests is synchronous enough that the race
never manifests, still add the test asserting the correct merged final state
(it documents the invariant and guards against a future regression of the queue).

**Verify**: `bun run check` → exit 0.

## Test plan

- New test: concurrent `saveStep` + `setStatus` → final state has both.
- Pattern to copy: existing `saveStep`/`loadRun` tests in
  `tests/unit/state/state-store.test.ts`.
- Verification: `bun test tests/unit/state/state-store.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `initRun`, `setArgs`, `setStatus`, and `saveStep` all route through the shared
      enqueue helper (`grep -n "#enqueueWrite" src/state/state-store.ts` shows 4
      call sites + the definition).
- [ ] The new concurrency test passes.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 011 updated.

## STOP conditions

Stop and report if:

- Routing `initRun` through the queue changes resume behavior — note the comment at
  `state-store.ts:463-464` ("resume() bypasses initRun()"); if serializing `initRun`
  breaks a resume test, report before forcing it.
- The excerpts don't match the live code (drift).
- Any existing state-store test fails in a way not explained by ordering.

## Maintenance notes

- Any NEW method that mutates `state.json` for a run must also go through
  `#enqueueWrite`. Add a one-line comment on the helper stating this rule.
- Reviewer: confirm error propagation is preserved — callers of `setStatus`/`setArgs`
  must still see thrown errors (await the un-swallowed `next`, not the swallowed
  chain reference).
