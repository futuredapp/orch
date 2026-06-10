# `makeConfirmSpy` asserts against a service the headless-retry path never consults

**Source:** CE L8 (LOW). Verified against the code.
**Status:** Not a fix in this pass — low-signal test, not wrong.

## What the issue is

AT-R8 asserts `confirm.calls() === 0` to prove the headless `orch retry` path never prompts. But
`retryRun → runResumeExecution` never references `deps.confirmService` at all, so the spy counts calls to a
service the path **structurally cannot reach**. The assertion therefore proves "this code doesn't touch a
service it was never wired to," which would pass identically with a plain `FakeConfirmService` (which throws
on any unscripted `confirm`).

## Where it is

- `tests/integration/cli/commands/retry.test.ts` ~`:1363` (`makeConfirmSpy` definition), used ~`:1489`.
- The path under test: `src/cli/commands/retry.ts` (`retryRun`) → `src/cli/commands/resume-execution.ts`
  (`runResumeExecution`) — no `confirmService` reference.

## Why it matters

It is lower-signal than it looks: the test reads as "we proved no prompt fired on the headless path," but the
real guarantee comes from the path not depending on `ConfirmService` in the first place. A reader could
over-trust it. Not a bug — the behavior it implies (headless retry never prompts) is genuinely true.

## Why it is recorded here, not fixed

Pure test-clarity polish with no behavior or coverage change; not worth bundling into the correctness pass.

## Suggested next step

Either drop the spy and rely on the throw-on-unscripted default `FakeConfirmService` (the throw already
guarantees "no prompt"), or change the comment to state precisely what is proven: "no `ConfirmService` is
consulted on the headless retry path."
