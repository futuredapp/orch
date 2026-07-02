# Plan 007: Make `orch logs --follow` exit on a `failed` run

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. When done, update
> the status row for plan 007 in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/commands/logs.ts`
> If `logs.ts` changed since this plan was written, compare the "Current state"
> excerpt below against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`orch logs --step <name> --follow` is the command the debugging guide tells users
to run to watch a step live. Its terminal-status predicate omits `'failed'`, so
when a run ends in `failed` (the case you most want to watch), the tail loop never
detects termination and hangs until the user hits Ctrl-C. The tool looks frozen at
exactly the moment it should say "this step failed, here's the transcript." One
missing enum value is the whole bug.

## Current state

- `src/cli/commands/logs.ts` — the `orch logs` command, including the `--follow`
  tail loop.
- The run-status enum is `'running' | 'completed' | 'failed' | 'crashed'`
  (defined on `RunState['status']` in `src/state/state-store.ts`).
- The bug, at `src/cli/commands/logs.ts:244`:

  ```ts
  const isTerminalStatus = (s: RunState['status']): boolean => s === 'completed' || s === 'crashed'
  ```

  This predicate gates two things: the already-terminal short-circuit at
  `logs.ts:262` (print persisted transcript and exit) and the follow loop's
  status poll (`pollStatusUntilTerminal`, around `logs.ts:310-323`). Because
  `'failed'` is missing, a failed run is treated as still-running by both.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Targeted test | `bun test tests/unit/cli/logs-command.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/cli/commands/logs.ts` (the one-line predicate fix)
- `tests/unit/cli/logs-command.test.ts` (add a regression test)

**Out of scope (do NOT touch):**
- The status enum in `src/state/state-store.ts` — it is already correct.
- Any other predicate or poll logic in `logs.ts` beyond `isTerminalStatus`.

## Steps

### Step 1: Add `'failed'` to the terminal-status predicate

In `src/cli/commands/logs.ts:244`, change:

```ts
const isTerminalStatus = (s: RunState['status']): boolean => s === 'completed' || s === 'crashed'
```

to:

```ts
const isTerminalStatus = (s: RunState['status']): boolean =>
  s === 'completed' || s === 'crashed' || s === 'failed'
```

Do not change anything else.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Add a regression test

Open `tests/unit/cli/logs-command.test.ts`. Find an existing test that drives
`--follow` against a run that reaches a terminal status (search the file for
`follow` and for `'completed'`). Mirror its arrange/act/assert structure to add a
test whose run status is `'failed'`, asserting that `logsCmd` (or the follow path
it exercises) returns rather than hanging — i.e. the call resolves and the persisted
transcript is printed.

If the test harness in that file drives the follow loop with a fake clock/state
store, model the new test on the existing `'completed'` case exactly, only changing
the seeded status to `'failed'`. Give the test a full-sentence name, e.g.:
`it('exits the follow loop when the run terminates as failed', ...)`.

**Verify**: `bun test tests/unit/cli/logs-command.test.ts` → all pass, including the
new test. Confirm the new test genuinely completes (does not time out).

### Step 3: Run the gate

**Verify**: `bun run check` → exit 0.

## Test plan

- New test in `tests/unit/cli/logs-command.test.ts`: a `--follow` run that ends in
  `'failed'` resolves (does not hang) and prints the persisted transcript.
- Structural pattern to copy: the existing `'completed'`/`'crashed'` follow test in
  the same file.
- Verification: `bun test tests/unit/cli/logs-command.test.ts` → all pass, 1 new
  test.

## Done criteria

ALL must hold:

- [ ] `grep -n "s === 'failed'" src/cli/commands/logs.ts` returns the updated
      predicate line.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun test tests/unit/cli/logs-command.test.ts` passes with the new
      `'failed'` test.
- [ ] `bun run check` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` row 007 updated.

## STOP conditions

Stop and report if:

- `logs.ts:244` does not contain the `isTerminalStatus` arrow shown above (drift).
- The existing follow tests use a mechanism you cannot cleanly mirror for a
  `'failed'` status without touching out-of-scope files.
- Adding `'failed'` breaks an existing test that assumed a failed run keeps
  following — that would mean the hang is load-bearing somewhere; report it.

## Maintenance notes

- If a new terminal status is ever added to `RunState['status']`, this predicate
  must be updated too — consider centralizing terminal-status detection in
  `src/state/` in a follow-up so `logs.ts` and `status.ts` share it (plan 008 also
  reasons about terminal status).
- Reviewer should confirm the new test actually asserts termination (resolves),
  not merely that output was printed.
