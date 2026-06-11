# Plan 003: Replace fixed-sleep-then-assert patterns in tests with poll-until-condition

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- tests/unit/cli/tail-lines.test.ts tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts src/cli/commands/tail-lines.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

Two test files synchronize with background activity by sleeping a fixed
wall-clock duration and then asserting. Under CI load or full-suite CPU
contention (this repo has a documented history of real-tmux suite flakiness),
the background work can take longer than the sleep, producing spurious
failures. The repo's own `docs/testing-strategy.md` flags real timers as a
flaky pattern. The fix is mechanical: never abort/assert on a timer — poll
for the expected condition with a generous deadline, so a fast machine passes
in milliseconds and a slow machine still passes within the budget.

## Current state

### File 1: `tests/unit/cli/tail-lines.test.ts`

Tests `tailLines` — an async generator in `src/cli/commands/tail-lines.ts`
that polls a file every `TICK_MS = 100` ms and yields newline-terminated
lines (used by `orch logs --follow`). The generator deliberately lives
outside the FsService port (documented in its header, "Plan AD-10") — do NOT
try to inject a fake clock or fake fs into it.

The flake pattern — fixed 250 ms sleeps between appends, then `ctrl.abort()`:

```typescript
// tests/unit/cli/tail-lines.test.ts:39-48
    // Append three complete lines spread across two ticks so we exercise
    // the offset-advance + chunk-split loop.
    await fs.appendFile(file, 'one\ntwo\n')
    await new Promise((r) => setTimeout(r, 250))
    await fs.appendFile(file, 'three\n')
    await new Promise((r) => setTimeout(r, 250))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['one', 'two', 'three'])
```

If the generator's read loop is starved for >250 ms, `abort()` fires before
the lines are read → the test fails. Same pattern in the other two tests
(lines 51–69 and 71–86). The collector currently hides its output inside a
closure until the generator finishes:

```typescript
// tests/unit/cli/tail-lines.test.ts:22-28
const collect = (signal: AbortSignal, file: string): Promise<string[]> => {
  const out: string[] = []
  return (async () => {
    for await (const line of tailLines(path(file), signal)) out.push(line)
    return out
  })()
}
```

### File 2: `tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts`

A real-tmux test that already uses the harness's polling assertion at the end
(`harness.left.waitFor(...)` with `REAL_TMUX_ASSERT_TIMEOUT_MS`, lines
138–143) — good. But the initial mount still uses a bare sleep:

```typescript
// tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts:98-100
        // Initial render: give the Ink child time to mount + draw its first
        // frame.
        await sleep(400)
```

If the Ink child takes >400 ms to draw its first frame (cold cache, loaded
CI box), the subsequent resize-drags exercise an unmounted pane and the test
loses its purpose (it can also flake). The harness exposes
`harness.left.waitFor((paneContent: string) => boolean, { timeoutMs })`
(see its use at lines 138–143) — use it to wait for the first frame instead.

The `sleep(120)` calls inside `drag()` (line 94) are pacing between SIGWINCH
deliveries, not assertions — they are NOT a flake source (a slow machine just
coalesces resizes) and stay as-is, with a clarifying comment.

### Harness facts

- `canRunRealTmux()` gates the real-tmux test — it auto-skips when tmux is
  unavailable. The constants `REAL_TMUX_ASSERT_TIMEOUT_MS` /
  `REAL_TMUX_TEST_TIMEOUT_MS` come from `@orch/test/real-tmux/index.ts`
  (alias for `tests/_support/real-tmux/`).
- Repo test rules: full-sentence test names, AAA with blank lines, never bare
  `bun test` — always pass explicit paths.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| tail-lines tests | `bun test tests/unit/cli/tail-lines.test.ts` | 3 pass |
| real-tmux test | `bun test tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts` | passes, or cleanly skips when tmux is unavailable |
| Lint / typecheck | `bun run lint && bun run typecheck` | exit 0 |
| Unit tier | `bun run test:unit` | all pass |

## Scope

**In scope**:
- `tests/unit/cli/tail-lines.test.ts` (rewrite the synchronization, keep the
  three behaviors under test)
- `tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts`
  (replace the mount sleep only)

**Out of scope** (do NOT touch):
- `src/cli/commands/tail-lines.ts` — the production generator is correct;
  do not add test-only parameters (tick injection, fake clocks) to it.
- `tests/_support/real-tmux/` — the harness; if `waitFor` doesn't behave as
  described, that's a STOP condition, not a harness patch.
- Other tests with sleeps — Step 3 only *inventories* them.

## Steps

### Step 1: Rewrite `tail-lines.test.ts` synchronization

Restructure so the test aborts only after the expected output has been
observed, never on a timer:

1. Change `collect` to push into a caller-supplied array so progress is
   observable mid-flight:

   ```typescript
   const collectInto = (signal: AbortSignal, file: string, out: string[]): Promise<string[]> =>
     (async () => {
       for await (const line of tailLines(path(file), signal)) out.push(line)
       return out
     })()
   ```

2. Add a local poll helper (test-file scope, not shared infra):

   ```typescript
   /** Poll `cond` every 10 ms until true; throw after `timeoutMs`. */
   const waitUntil = async (cond: () => boolean, timeoutMs = 5000): Promise<void> => {
     const deadline = Date.now() + timeoutMs
     while (!cond()) {
       if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
       await new Promise((r) => setTimeout(r, 10))
     }
   }
   ```

3. Test "yields one line for each newline-terminated chunk…": append
   `'one\ntwo\n'`, `await waitUntil(() => out.length >= 2)`, append
   `'three\n'`, `await waitUntil(() => out.length >= 3)`, then `ctrl.abort()`
   and assert `await collector` equals `['one', 'two', 'three']`.
4. Test "holds a partial line across ticks…": append `'half-'`, wait two
   generator ticks' worth (`await new Promise((r) => setTimeout(r, 250))` may
   remain here ONLY as best-effort pacing to make the split-read path likely —
   add a comment saying the test passes either way and the sleep is not a
   correctness synchronization), append `'and-half\n'`, then
   `await waitUntil(() => out.includes('half-and-half'))`, abort, assert
   `['half-and-half']`.
5. Test "flushes a non-empty pending partial on abort": the file starts with
   `'final fragment'` (no newline), so nothing is yielded before abort. Wait
   until the generator has *read* the fragment — there is no observable
   signal, so instead seed the file with one terminated line plus the
   fragment: `'sentinel\nfinal fragment'`, then
   `await waitUntil(() => out.includes('sentinel'))` (proves the read loop has
   consumed the file through the fragment), abort, and assert the result is
   `['sentinel', 'final fragment']`. Keep the test name accurate — it still
   proves the abort-flush of a pending partial.

**Verify**: `bun test tests/unit/cli/tail-lines.test.ts` → 3 pass. Then run
it 20× to shake out timing: 
`for i in $(seq 20); do bun test tests/unit/cli/tail-lines.test.ts || break; done`
→ 20 consecutive passes.

### Step 2: Replace the mount sleep in the real-tmux test

Replace lines 98–100 (`await sleep(400)`) with a first-frame poll:

```typescript
        // Initial render: wait for the Ink child's first frame (the
        // breadcrumb) instead of sleeping a fixed duration.
        await harness.left.waitFor((pane) => pane.includes('orch · tic-tac-toe · '), {
          timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
        })
```

Add one comment above the `sleep(120)` inside `drag()` noting it is pacing
between SIGWINCH deliveries, not an assertion synchronization, and is
intentionally a plain sleep.

**Verify**: if `tmux` is available in your environment:
`bun test tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts`
→ passes. If the test reports it skipped (gated by `canRunRealTmux`), record
that in your report — the change still ships, reviewed by reading.

### Step 3: Inventory (report only) other fixed-sleep-then-assert sites

Run:
`grep -rn "setTimeout(r, \|await sleep(\|Bun.sleep(" tests/unit tests/integration --include="*.test.ts" | grep -v real-tmux`
and list, in your final report, any OTHER test files where a fixed sleep is
followed by an assertion on background work. Do NOT fix them in this plan.

**Verify**: the list appears in your completion report (empty list is fine).

## Test plan

This plan modifies tests; the "tests of the tests" are the repeat-run loop in
Step 1's verification and the gates below.

## Done criteria

- [ ] `tests/unit/cli/tail-lines.test.ts` contains no `setTimeout(...)` whose
      expiry gates an abort-then-assert (the one documented best-effort pacing
      sleep in the partial-line test is allowed, with its comment)
- [ ] 20 consecutive passes of `bun test tests/unit/cli/tail-lines.test.ts`
- [ ] `tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts` has
      no `sleep(400)` mount wait; first frame is awaited via `waitFor`
- [ ] `bun run lint`, `bun run typecheck`, `bun run test:unit` all exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `harness.left.waitFor` does not exist or its signature differs from the
  usage at lines 138–143 of the real-tmux test.
- The rewritten tail-lines tests fail consistently (not flakily) — that would
  indicate a real generator bug, which is out of scope to fix here.
- You are tempted to modify `src/cli/commands/tail-lines.ts` or the real-tmux
  harness — both are out of scope.

## Maintenance notes

- The `waitUntil` helper is deliberately file-local. If a third test file
  needs it, THEN promote it into `tests/_support/` — not before.
- Reviewer should scrutinize: the partial-line test must still assert the
  hold-across-ticks behavior *outcome*, even though the path-exercising sleep
  is best-effort.
- Follow-up deferred: any sites surfaced by Step 3's inventory.
