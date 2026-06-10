# Host-fake duplication across four test files

**Source:** CE L9 (LOW). Verified against the code.
**Status:** Not a fix in this pass — test-maintainability churn.

## What the issue is

Three test files hand-roll the full `Host` interface inline, while two newer files build on the shared
`createFakeHost`. When the `Host` interface gains a method, the inline literals all break in lockstep and
tend to drift apart.

## Where it is

- Hand-rolled inline `Host` fakes:
  - `tests/integration/cli/commands/resume-finished.test.ts`
  - `tests/integration/cli/commands/bare-resume-fallback.test.ts`
  - `tests/integration/cli/commands/open-finished.test.ts`
- Shared helper already used by the newer files: `@orch/test/fake-host.ts` (`createFakeHost`), used by
  `open-failed.test.ts` and `retry.test.ts`.

## Why it matters

Four-way duplication of a growing interface is a maintenance drag: every `Host` change is a four-file edit,
and small per-file divergences make the fakes behave subtly differently across the suite. Consolidating onto
one builder keeps them honest and cuts the edit cost.

## Why it is recorded here, not fixed

It is test-infrastructure cleanup with no behavior or coverage change; deferred to keep the fix-plan focused
on correctness and reliability.

## Suggested next step

Migrate the three hand-rolled files onto `createFakeHost({ mode: 'two-pane' })`, layering the small
`awaitForegroundShutdown`/spy overrides each test actually needs. Re-run the affected integration suites to
confirm parity.
