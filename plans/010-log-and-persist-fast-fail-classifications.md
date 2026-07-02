# Plan 010: Log and persist fast-fail classifications

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 010 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/core/recovery/loop.ts src/core/workflow.ts`
> This is actively-reworked code. On any change, compare the "Current state"
> excerpts against the live code; on a mismatch, STOP and report.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 009 (edits the same `workflow.ts` region — land 009 first)
- **Category**: debugging / observability
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

When an autonomous step fast-fails (category `launch`/`billing`/`auth`/`rate_limit`/
`usage_limit`/etc.), the recovery loop returns immediately with an **empty**
recovery log. Because the failed-step persistence is gated on
`recoveryLog.length > 0`, **no `StepEntry` is written**, and because the loop has no
logger, **no log line names the chosen category**. So a fast-fail leaves no
`errorClass` in `state.json` and no trace naming why it died — the same
un-diagnosable failure the recovery rework was meant to eliminate, reappearing on
the fail-fast branch. Diagnosing a misclassification in the field becomes
impossible without adding code. This plan records the classification.

## Current state

- `src/core/recovery/loop.ts:33` — the outcome union:
  ```ts
  export type RecoveryOutcome = 'progressed' | 'errored-again' | 'gave-up' | 'completed'
  ```
- `src/core/recovery/loop.ts:144-154` — the fail-fast branch returns with the log
  still empty:
  ```ts
  if (verdict.kind === 'fail') {
    return {
      ok: false,
      recoveryLog: log,          // <-- never pushed to; empty
      failure: {
        kind: 'fail',
        category: classified.category,
        ...(verdict.resetsAt !== undefined ? { resetsAt: verdict.resetsAt } : {}),
      },
    }
  }
  ```
  Compare the give-up branch just below (`loop.ts:156-165`) which DOES
  `log.push({... outcome: 'gave-up'})` before returning.
- `src/core/workflow.ts:1592` — persistence is gated:
  ```ts
  if (loop.recoveryLog.length > 0) await persistRecoveryFailure(args, loop.recoveryLog)
  ```
  So an empty log ⇒ no `StepEntry` for the failed step.
- `src/core/workflow.ts:1639-1665` — `persistRecoveryFailure` writes a `StepEntry`
  carrying `recoveryLog` and `recoveryGaveUp: true`. Each `RecoveryLogEntry`
  (`loop.ts:35-47`) has an `errorClass: ErrorCategory` field — so a pushed entry
  records the category into `state.json`.
- The persisted schema for the log outcome is `z.string()`
  (`src/state/state-store.ts:248`) and is documented forward-tolerant
  (`loop.ts:31-33`), so **adding a new outcome literal does not break state
  loading**.
- `runAgentWithRecovery` (the function containing the `workflow.ts:1592` throw) has
  `deps.logger` in scope via `args.attemptDeps.deps.logger` (see
  `persistRecoveryFailure` using `deps.logger` at `workflow.ts:1663`), and
  `orchLog` is already imported in `workflow.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Recovery + state tests | `bun test tests/unit/core/recovery/loop.test.ts tests/integration/core/recovery-simulated.test.ts tests/unit/state/state-store-recovery-log.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/core/recovery/loop.ts` — add the outcome literal + push a log entry in the
  fail branch.
- `src/core/workflow.ts` — add one `orchLog` line near the fail-fast throw.
- `tests/unit/core/recovery/loop.test.ts` — assert the fail branch now logs.

**Out of scope (do NOT touch):**
- `formatRecoveryFailure` (plan 009 owns the message).
- `src/runners/*/classify-error.ts` — do not change classification logic.
- `StepEntry` shape.

## Steps

### Step 1: Add a `failed-fast` outcome literal

In `src/core/recovery/loop.ts:33`, extend the union:

```ts
export type RecoveryOutcome = 'progressed' | 'errored-again' | 'gave-up' | 'completed' | 'failed-fast'
```

**Verify**: `bun run typecheck` → exit 0 (no exhaustive-switch errors; if one
appears, a `switch` over `RecoveryOutcome` needs a `failed-fast` case — add a
minimal one mirroring `gave-up`, and note it in your report).

### Step 2: Record the classification in the fail branch

In `src/core/recovery/loop.ts:144`, before the `return`, push a log entry (mirror
the give-up branch's push at `loop.ts:157-163`):

```ts
if (verdict.kind === 'fail') {
  log.push({
    attemptIndex: attemptIndex + 1,
    errorClass: classified.category,
    waitMs: 0,
    parentSessionId: checkpointSessionId,
    outcome: 'failed-fast',
  })
  return {
    ok: false,
    recoveryLog: log,
    failure: {
      kind: 'fail',
      category: classified.category,
      ...(verdict.resetsAt !== undefined ? { resetsAt: verdict.resetsAt } : {}),
    },
  }
}
```

This makes `recoveryLog.length > 0`, so the existing
`persistRecoveryFailure` at `workflow.ts:1592` now writes a `StepEntry` carrying
`errorClass: <category>`.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Emit a log line naming the category

At the fail-fast throw site in `src/core/workflow.ts` (the block around line 1592,
after plan 009's changes), add an `orchLog` before the `throw` naming the category
and exit code. Use the logger already reachable there (the same `deps.logger`
`persistRecoveryFailure` uses). Example:

```ts
orchLog(deps.logger, 'recovery-fail-fast', {
  category: loop.failure.kind === 'fail' ? loop.failure.category : undefined,
  exitCode: first.result.exitCode,
})
```

Place it so it fires for the fail-fast (`loop.failure.kind === 'fail'`) case. If
`deps` is not directly in scope at that exact line, derive it the same way
`persistRecoveryFailure` receives it (`args.attemptDeps.deps`). Do not restructure
the function.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Tests

Add to `tests/unit/core/recovery/loop.test.ts` (mirror the existing give-up /
ceiling tests, e.g. `loop.test.ts:202,363`): a test driving a fail-fast category
that asserts `result.ok === false`, `result.recoveryLog.length === 1`, and
`result.recoveryLog[0].outcome === 'failed-fast'` with `errorClass` equal to the
category.

**Verify**: `bun test tests/unit/core/recovery/loop.test.ts` → all pass, then
`bun run check` → exit 0.

## Test plan

- `tests/unit/core/recovery/loop.test.ts`: fail-fast now pushes exactly one
  `failed-fast` log entry carrying the category.
- Optional (if the integration harness makes it easy): in
  `tests/integration/core/recovery-simulated.test.ts`, assert that after a
  fast-fail the run's `state.json` has a persisted step entry with the category in
  its `recoveryLog`. Only add this if the existing tests already inspect persisted
  state; otherwise skip and note it.
- Verification: the recovery + state test command → all pass.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `grep -n "failed-fast" src/core/recovery/loop.ts` shows the literal and the push.
- [ ] `grep -n "recovery-fail-fast" src/core/workflow.ts` shows the log line.
- [ ] `bun test tests/unit/core/recovery/loop.test.ts` passes with the new test.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 010 updated.

## STOP conditions

Stop and report if:

- Adding the `failed-fast` literal causes an exhaustive-switch type error you cannot
  resolve by mirroring the `gave-up` case in one place.
- The `RecoveryLogEntry` shape at `loop.ts:35-47` differs from the excerpt (drift).
- `orchLog` or `deps.logger` is not reachable at the throw site without
  restructuring the function.

## Maintenance notes

- After this lands, plan 008's `status` command can read the persisted
  `errorClass` directly instead of best-effort parsing the lifecycle log — update
  the `// TODO: prefer persisted errorClass` note there.
- Reviewer: verify the new `failed-fast` entry does not miscount attempts in
  `formatRecoveryFailure`'s give-up branch (it filters `outcome !== 'gave-up'`, but
  `failed-fast` only appears on the fail branch, never alongside give-up).
