# Plan 009: Preserve the real error message on the recovery-declined path

> **Executor instructions**: Follow step by step; run every verification command.
> If a STOP condition occurs, stop and report. Update the plan 009 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/core/workflow.ts src/core/recovery/loop.ts src/runners/execute.ts`
> This code was being actively reworked when the plan was written. If any of these
> changed, compare the "Current state" excerpts against the live code; on a
> mismatch treat it as a STOP condition and report what differs.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (land before 010 — both edit `workflow.ts` near line 1592)
- **Category**: bug
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

When an autonomous step fails with a non-retryable ("fail-fast") category — e.g. a
Codex launch crash like `Error loading rules: … invalid decision: deny` — the
runner's real stderr is captured and folded into the terminal event message, but
the recovery layer throws it away. The user sees only
`recovery declined — launch is not retryable`, with the actual cause stripped out.
This is the exact "can't tell why it died" symptom the recovery rework set out to
fix. Threading the terminal message back into the thrown error restores it.

## Current state

- `src/runners/execute.ts:144-156` — a runner that dies before a terminal event
  folds the stderr tail into `finalEvent.message`, so the real reason IS present on
  `first.result.finalEvent.message`.
- `src/core/workflow.ts:1667-1671` — `terminalErrorMessage` extracts that message:

  ```ts
  function terminalErrorMessage(result: RunnerRunResult): string {
    return result.finalEvent.type === 'error'
      ? result.finalEvent.message
      : `runner exited ${result.exitCode}`
  }
  ```

- `src/core/workflow.ts:1559` — the **non-recovery-capable** path already uses it:
  `throw new StepError(key, first.result.exitCode, terminalErrorMessage(first.result))`.
- `src/core/workflow.ts:1592-1597` — the **recovery-capable** path (codex/claude
  with `backoffResume`) throws WITHOUT the terminal message:

  ```ts
  if (loop.recoveryLog.length > 0) await persistRecoveryFailure(args, loop.recoveryLog)
  throw new StepError(
    key,
    first.result.exitCode,
    formatRecoveryFailure(loop.failure, loop.recoveryLog),
  )
  ```

- `src/core/recovery/loop.ts:261-271` — `formatRecoveryFailure`'s fail branch returns
  `recovery declined — ${category} is not retryable` and never includes the
  terminal message. (Leave this function alone — changing it would churn its unit
  tests; compose at the throw site instead.)

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Recovery tests | `bun test tests/integration/core/recovery-simulated.test.ts tests/integration/core/recovery-loop.test.ts tests/unit/core/recovery/loop.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/core/workflow.ts` — the throw at lines 1593-1597 only.
- Whatever test asserts the resulting `StepError` message (find it in Step 3).

**Out of scope (do NOT touch):**
- `src/core/recovery/loop.ts` `formatRecoveryFailure` — do not modify it.
- `src/runners/execute.ts` — the message is already folded there correctly.
- Plan 010's concern (logging/persisting the classification) — do not add logging
  here.

## Steps

### Step 1: Compose the thrown message with the terminal message

Replace the throw at `src/core/workflow.ts:1593-1597` so the `StepError` message is
`formatRecoveryFailure(...)` followed by the runner's terminal message:

```ts
if (loop.recoveryLog.length > 0) await persistRecoveryFailure(args, loop.recoveryLog)
const recoverySummary = formatRecoveryFailure(loop.failure, loop.recoveryLog)
const terminal = terminalErrorMessage(first.result)
throw new StepError(
  key,
  first.result.exitCode,
  `${recoverySummary}\n${terminal}`,
)
```

Do not change the `exitCode` argument or the `persistRecoveryFailure` call.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Run the recovery test suites

**Verify**: the recovery command above → all pass. Some tests may assert the exact
`StepError` message string (e.g. expecting `recovery declined — launch is not
retryable`). If a test now fails only because the message has additional lines
appended, that is expected — proceed to Step 3.

### Step 3: Update any message-assertion tests

Search the test tree for assertions on the declined/fail-fast message:

```
grep -rn "recovery declined\|is not retryable" tests/
```

For each hit that asserts the full `StepError` message equals the old string,
update it to assert the message **contains** `recovery declined — <category> is not
retryable` AND contains the terminal reason (e.g. use `.toContain(...)` twice
instead of `.toBe(...)`). Do not weaken assertions that target `formatRecoveryFailure`
directly (that function is unchanged) — only the ones on the thrown `StepError`.

**Verify**: re-run the recovery command → all pass.

### Step 4: Add a regression test

In `tests/integration/core/recovery-simulated.test.ts` (mirror its existing
fail-fast / declined case — search for a test that drives a non-retryable
category), add a test asserting the thrown `StepError.message` contains BOTH the
`recovery declined` phrase AND a distinctive substring of the simulated runner's
stderr/terminal message (prove the reason survives). Full-sentence test name, e.g.
`it('includes the runner error message when recovery declines a fail-fast category', ...)`.

**Verify**: `bun run check` → exit 0.

## Test plan

- Regression test in `tests/integration/core/recovery-simulated.test.ts`: a
  fail-fast category throws a `StepError` whose message includes the runner's real
  error text.
- Pattern to copy: the existing declined/fail-fast test in that file.
- Verification: the recovery test command → all pass with the new test.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] The `StepError` thrown at `workflow.ts:~1593` includes `terminalErrorMessage(first.result)`.
- [ ] `src/core/recovery/loop.ts` is unchanged (`git diff --stat` shows no change to it).
- [ ] The new regression test passes and asserts the reason survives.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 009 updated.

## STOP conditions

Stop and report if:

- The excerpt at `workflow.ts:1593-1597` does not match (drift — the rework moved
  it). Report the live shape.
- `terminalErrorMessage` no longer exists or changed signature.
- More than ~5 tests assert the exact old message string — that suggests the
  message is a wider contract; report before mass-editing.

## Maintenance notes

- Plan 010 edits the same region (persisting/logging the classification). Land 009
  first; 010's diff assumes this composed-throw shape.
- Reviewer: confirm the terminal message isn't duplicated when the category is a
  give-up (both branches now append it — that's intentional and still additive).
