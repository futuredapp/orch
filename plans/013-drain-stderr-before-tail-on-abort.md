# Plan 013: Drain stderr before reading its tail on the abort path

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 013 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/execute.ts`
> This file was being reworked at planning time. On any change, compare the
> "Current state" excerpt against the live code; on a mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

When the recovery watchdog kills a hung attempt, the run unwinds through the
`AbortError` path. On that path the stderr drain is **not awaited** before the
retained stderr tail is read, so the tail can be empty or truncated. Since that
tail is (a) folded into the synthesized error message the user sees and (b) read by
the classifier's launch-failure heuristic, an aborted attempt can produce an error
with no reason — or even flip its classification. This weakens observability on
exactly the abort path.

## Current state

`src/runners/execute.ts`:

- The drain is started concurrently and already guarded against rejection
  (`:105-109`):
  ```ts
  const stderrTail = makeBoundedTail(STDERR_TAIL_MAX_CHARS)
  const stderrDone = drainStream(handle.stderr, (line) => {
    stderrTail.push(line)
    deps.onRawLine?.('stderr', line)
  }).catch(() => {})
  ```
- The success path awaits it; the abort path does **not** (`:114-139`):
  ```ts
  try {
    for await (const line of handle.stdout) { /* ... */ }
    const waitResult = await handle.wait()
    exitCode = waitResult.exitCode
    await stderrDone                 // <-- success path only
  } catch (err) {
    if (!isAbortError(err)) throw err
    exitCode = -1                    // <-- abort path: stderrDone NOT awaited
  } finally {
    if (deps.signal !== undefined) deps.signal.removeEventListener('abort', onAbort)
    safeKill(handle)
  }
  const durationMs = deps.clock.now() - startedAt
  const stderr = stderrTail.value()  // <-- read here, possibly before drain flush
  ```
- `stderrDone` is already `.catch(() => {})`-guarded, so awaiting it is always safe
  (it never rejects).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Runner exec tests | `bun test tests/unit/runners` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/runners/execute.ts` — move the `await stderrDone` so it runs on both paths.
- A unit test asserting stderr survives an aborted attempt (Step 2).

**Out of scope (do NOT touch):**
- `drainStream`, `makeBoundedTail`, `safeKill`, `isAbortError`.
- The recovery loop / watchdog.

## Steps

### Step 1: Await the drain on all paths

Move `await stderrDone` out of the success branch so it is awaited before
`stderrTail.value()` is read regardless of path. Preferred shape — put it in the
`finally`, or immediately after the `try/catch` and before `const stderr =
stderrTail.value()`:

```ts
try {
  for await (const line of handle.stdout) { /* unchanged */ }
  const waitResult = await handle.wait()
  exitCode = waitResult.exitCode
} catch (err) {
  if (!isAbortError(err)) throw err
  exitCode = -1
} finally {
  if (deps.signal !== undefined) deps.signal.removeEventListener('abort', onAbort)
  safeKill(handle)
}

await stderrDone // both the normal and AbortError paths flush the tail first

const durationMs = deps.clock.now() - startedAt
const stderr = stderrTail.value()
```

Remove the now-redundant `await stderrDone` inside the `try`. Do not change
`exitCode` handling.

**Verify**: `bun run typecheck` → exit 0; `bun test tests/unit/runners` → all pass.

### Step 2: Add a regression test

Find the existing unit test that exercises `runRunner`/the execute path with an
abort (search `tests/unit/runners` for `abort`, `AbortController`, or `watchdog`).
Add a test where the attempt is aborted mid-run but stderr lines were emitted
before the abort, asserting the returned `stderr` (and the synthesized
`finalEvent.message`) contains those lines. Mirror the existing abort test's setup
(fake process handle / stream). Full-sentence name, e.g.
`it('retains the stderr tail when an attempt is aborted before it exits', ...)`.

If no abort-path test exists to mirror, model it on the closest `runRunner` test
that provides a fake `handle` with separate stdout/stderr streams, and drive the
`deps.signal` abort. If constructing that fake is not feasible from the existing
harness, STOP and report rather than inventing a new fake.

**Verify**: `bun run check` → exit 0.

## Test plan

- New test: aborted attempt still surfaces its stderr tail in `stderr` and in the
  synthesized `finalEvent.message`.
- Pattern to copy: the existing abort / watchdog runner test under
  `tests/unit/runners`.
- Verification: `bun test tests/unit/runners` → all pass.

## Done criteria

ALL must hold:

- [ ] `await stderrDone` runs before `stderrTail.value()` on both the normal and
      abort paths (only one `await stderrDone` remains, positioned after the
      try/catch or in `finally`).
- [ ] `bun run typecheck` exits 0.
- [ ] The new abort-path stderr test passes.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 013 updated.

## STOP conditions

Stop and report if:

- The excerpt at `execute.ts:114-142` does not match the live code (rework drift).
- Moving `await stderrDone` into `finally` changes a return value in an existing
  test in a way you can't explain — report before forcing it.
- You cannot construct an abort-path test from the existing harness.

## Maintenance notes

- If the drain is ever changed to be able to reject (removing the `.catch`), this
  `await` must be re-guarded.
- Reviewer: confirm the drain await cannot deadlock if the child's stderr stream
  never closes after a kill — `safeKill(handle)` in `finally` runs first, which
  should close the pipe and let `drainStream` finish.
