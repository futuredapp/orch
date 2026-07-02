# Plan 012: Add exit-code regression tests for `mapResumeError`

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 012 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/commands/resume-execution.ts src/cli/main.ts`
> On any change, re-read `mapResumeError` and the `EXIT` map before writing the
> test table.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`mapResumeError` maps 6+ error types across three distinct process exit codes. CI
and automation depend on that exit-code contract (`orch resume`/`orch retry` exit
codes drive scripts). It currently has **zero direct test coverage** — a
reclassification (e.g. a `StateCorruptionError` slipping into the fallthrough)
would silently change the exit code callers see. This adds a cheap table-driven
guard on a pure function.

## Current state

`src/cli/commands/resume-execution.ts:52-70` — the pure function under test:

```ts
export function mapResumeError(err: unknown): { code: number; reason: string } | undefined {
  if (err instanceof RunNotFoundError || err instanceof ResumeError) {
    return { code: EXIT.CANNOT_RESUME, reason: err.message }
  }
  if (err instanceof ViewResolutionError || err instanceof StateCorruptionError) {
    return { code: EXIT.CONFIG_ERROR, reason: err.message }
  }
  if (
    err instanceof StepError ||
    err instanceof SchemaValidationError ||
    err instanceof ParallelError
  ) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  if (err instanceof HostUnavailableError) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  return undefined
}
```

Exit codes (`src/cli/main.ts:48-55`): `OK:0, STEP_FAILURE:1, CONFIG_ERROR:2,
CANNOT_RESUME:3, SIGINT:130, SIGTERM:143`.

- `mapResumeError` is exported (so importable directly in a unit test).
- `grep -rn "mapResumeError" tests/` returns zero references today — confirm this
  before starting.
- The error classes are exported from `../../core/index.ts` (see the imports at
  `resume-execution.ts:20-31`) and `HostUnavailableError` from
  `../../hosts/index.ts`; `StateCorruptionError` from `../../state/index.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm no coverage | `grep -rn "mapResumeError" tests/` | no output |
| Typecheck | `bun run typecheck` | exit 0 |
| New test | `bun test tests/unit/cli/map-resume-error.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `tests/unit/cli/map-resume-error.test.ts` (create).

**Out of scope (do NOT touch):**
- `src/cli/commands/resume-execution.ts` — this is a test-only plan; do not change
  the function. (If you believe the mapping is wrong, STOP and report — do not
  "fix" it here.)

## Steps

### Step 1: Confirm there is no existing coverage

**Verify**: `grep -rn "mapResumeError" tests/` → no output. If there ARE references,
STOP and report (the finding is stale).

### Step 2: Write the table-driven test

Create `tests/unit/cli/map-resume-error.test.ts`. Model its style on an existing
unit test under `tests/unit/cli/` (e.g. `tests/unit/cli/logs-command.test.ts`) —
`import { describe, expect, it } from 'bun:test'`, full-sentence test names,
Arrange-Act-Assert with blank-line separators.

Import `mapResumeError` from `../../../src/cli/commands/resume-execution.ts`, the
`EXIT` map from `../../../src/cli/main.ts`, and each error class from its barrel.
Construct a minimal instance of each error class (check each constructor's
signature — e.g. `new StepError(...)` needs specific args; read the class if
unsure) and assert:

| Input error | Expected `code` |
|-------------|-----------------|
| `RunNotFoundError` | `EXIT.CANNOT_RESUME` (3) |
| `ResumeError` | `EXIT.CANNOT_RESUME` (3) |
| `ViewResolutionError` | `EXIT.CONFIG_ERROR` (2) |
| `StateCorruptionError` | `EXIT.CONFIG_ERROR` (2) |
| `StepError` | `EXIT.STEP_FAILURE` (1) |
| `SchemaValidationError` | `EXIT.STEP_FAILURE` (1) |
| `ParallelError` | `EXIT.STEP_FAILURE` (1) |
| `HostUnavailableError` | `EXIT.STEP_FAILURE` (1) |
| `new Error('unmapped')` | returns `undefined` |

Also assert the `reason` equals the error's `message` for one representative case.

If constructing a particular error class needs awkward arguments, use the minimal
valid args (read the class definition to find them) — do not stub or mock; these
are plain value classes.

**Verify**: `bun test tests/unit/cli/map-resume-error.test.ts` → all pass.

### Step 3: Gate

**Verify**: `bun run check` → exit 0.

## Test plan

- One test file, ~9 assertions (8 mapped classes + 1 unmapped → undefined), plus a
  `reason` check.
- Pattern to copy: `tests/unit/cli/logs-command.test.ts` structure.
- Verification: `bun test tests/unit/cli/map-resume-error.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `tests/unit/cli/map-resume-error.test.ts` exists and covers all 8 mapped error
      types + the unmapped → `undefined` case.
- [ ] `bun test tests/unit/cli/map-resume-error.test.ts` passes.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run check` exits 0.
- [ ] No `src/` files modified (`git status` shows only the new test file).
- [ ] `plans/README.md` row 012 updated.

## STOP conditions

Stop and report if:

- A constructor signature makes an error class impractical to instantiate directly
  without other machinery — report which one; do not mock it.
- Any assertion fails — that means the live mapping differs from this plan's table
  (drift or a real bug). Report the discrepancy; do NOT change `mapResumeError`.

## Maintenance notes

- When a new resumable error type is added to `mapResumeError`, add its row here.
- Reviewer: confirm the test imports the real `EXIT` constants rather than
  hardcoding `1/2/3`, so a future renumbering keeps the test honest.
