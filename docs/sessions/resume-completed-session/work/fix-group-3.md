# Fix Group 3 — `[r]` single-step retry now runs attached (visible), not detached

**Status: done**

## What was wrong

`runSingleStepRetry` (`src/cli/commands/open-failed.ts`) built a full two-pane host via
`hostFactory`, then called `loaded.executor.retryStep(wfDeps)` **directly** and `host.teardown()` —
it never went through `executeWithAttach`/`attachForeground`. The `tmux attach-session` only happens
inside `attachForeground`, so `[r]` ran in a **detached** session: the viewer unmounted, the step
re-executed with nothing on screen, then the loop reopened a fresh read-only viewer with the result.
By contrast `[c]` (`runResumeExecution`) and `orch retry` both attach and are visible.

The latent defect: an **interactive** retried step would `runInteractive` into panes no human is
attached to (no input surface, possible hang). Even for autonomous steps the blank-screen-then-reopen
is not the "re-execute the failed step in place" that brainstorm D3 describes.

## The fix

`src/cli/commands/open-failed.ts` — `runSingleStepRetry` now routes the retry through
`executeWithAttach`, exactly as `[c]`/`orch retry` do:

```ts
return await executeWithAttach({
  host,
  workflow: loaded.executor.retryStep(wfDeps).then(() => {}),
  runId: targetId,
  stderr: process.stderr,
  mapError: mapResumeError,
  summary: { workflowName, runDir: relativeRunDir(deps.cwd, deps.statePath, targetId) },
  logger,
  skipAttach: opts.noAttach,
  readOnly: false,
})
```

Following the fix plan and the Phase-2 actioned-side-effects matrix:

- **`readOnly: false`** — the retry is a real execution the user watches (the viewer open stays
  `readOnly: true`).
- **No cmux host and no `beforeTeardown`** — a retry-only action must emit no `run:ended` and never
  touch the status pill; the run stays `failed` until a real `[c]` continue.
- **`mapError: mapResumeError`** keeps the failed-again-vs-genuine-crash classification intact:
  `retryStep` resolves with a `RetryStepResult` and never throws on a step-level re-failure (so
  `executeWithAttach` returns `EXIT.OK` and the loop reopens), while a genuine crash throws and is
  mapped to its code.
- `executeWithAttach` owns `host.teardown()` on every path, so the manual `try/catch … finally
  host.teardown()` was removed; the `logger.close()` `finally` stays.
- `retryStep`'s `Promise<RetryStepResult>` is adapted to the `Promise<void>` the race expects via
  `.then(() => {})` — the loop only needs the exit code, never the result value (the old code already
  ignored it).

The doc-comments on `runSingleStepRetry` were updated to describe the attached/visible behavior and
why no cmux/`run:ended`/pill fires.

## Tests

`tests/integration/cli/commands/open-failed.test.ts`:

- **New regression test** `[r] retry runs ATTACHED (visible), not detached (Group 3)` — drives `[r]`
  with a `FakeRunner`, captures every host the loop builds, and asserts the **retry-execution host**
  (index 1: viewer → retry exec → reopened viewer) recorded `attachedForeground() === true` and
  actually re-ran the failed step. Under the old detached behavior the retry-execution host never
  attached, so this test would fail.
- `makeScriptedHost` now also tracks/exposes `attachedForeground()` (previously a no-op
  `attachForeground`).
- AT-R1 / AT-R2 / AT-R10a updated: now that `[r]` is routed through `executeWithAttach`, the
  retry-execution host's `awaitForegroundShutdown` **is** consulted, so its scripted reason was
  changed from `quit` (which `executeWithAttach` maps to a mid-retry SIGINT) to the benign
  `attach-exited` (workflow settles, the user watches it, exit `0`). The pass/fail-again on-disk
  assertions are unchanged — proving the retry behavior itself is unchanged, only its visibility.

## Verification

- `bun test tests/integration/cli/commands/open-failed.test.ts` → 8 pass, 0 fail.
- `bun run check` → exit 0 (lint + typecheck + unit + mocked-integration + two-pane fast/screen/full/
  lifecycle + migration all green).

## Issues hit along the way

One subtlety: because the retry now goes through `executeWithAttach`, the retry-execution host's
`awaitForegroundShutdown` reason matters where it previously didn't (the old direct call never read
it). A scripted `quit` there is now interpreted as the user quitting **mid-retry** → `EXIT.SIGINT`,
which would have broken AT-R1/R2/R10a. Switching those scripted reasons to `attach-exited` (the same
benign settle `[c]`'s AT-R3 test already uses) resolves it and is the correct model: the user is
watching the retry run to completion, not aborting it.

`executeWithAttach` writes its normal end-of-run summary (`Workflow "…" completed.`) on the retry
path too. For a parked `[r]` this is a transient stderr line that the reopened viewer immediately
supersedes; the fix plan explicitly accepts this ("watches the retry exactly as `[c]` does"), so it
was left as-is rather than expanding scope to suppress it.

## Remaining groups

Groups 4, 5, 6 are still `not-started`.
