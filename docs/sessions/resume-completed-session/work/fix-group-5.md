# Fix Group 5 — Reliability edge cases (L2 + L3)

**Status: done.** Both reliability edge cases fixed, each with a regression test
proven to fail without its fix. `bun run check` is green.

## What was wrong, and the fix

### L2 — `onReadOnlyShutdown` dropped if `host.teardown()` throws

`executeWithAttach`'s read-only branch (`src/cli/commands/execute-with-attach.ts`)
ran `await opts.host.teardown()` **before** `opts.onReadOnlyShutdown(reason)`. If
teardown threw (tmux socket gone mid-command — a documented failure mode), the
callback never fired, so `openFailedView`'s captured `action` stayed `undefined`
and the open loop misread an already-decided `[r]`/`[c]` as `dismissed`.

**Fix.** Invoke `onReadOnlyShutdown(reason)` **before** teardown, and make the
read-only teardown non-fatal to the already-decided outcome
(`await opts.host.teardown().catch(() => {})` — the outcome is decided the moment
the foreground settles, and a read-only open is exiting anyway; the existing
signal-handler path already treats teardown failure as non-blocking). This is the
"or otherwise so a teardown failure cannot discard an already-decided action"
latitude the plan grants — moving the callback alone wasn't sufficient, because
the teardown throw would still propagate out of `executeWithAttach` (via
`resolveCaughtError`, which re-throws on its own teardown) and bypass
`openFailedView`'s `return { kind: 'action' }`.

### L3 — `findResumableRun` crashes bare `orch resume` on a corrupt recent run

`findResumableRun` (`src/cli/commands/resume.ts`) called
`deps.stateStore.loadRun(rid)` with no try/catch, so a `StateCorruptionError` on
any recent run aborted bare `orch resume` before it reached the new finished-run
fallback. Its sibling `findNewestFinishedRunId` already catches and skips
`StateCorruptionError`; the asymmetry meant one corrupt recent run silently
defeated the D5 fallback.

**Fix.** Mirror the corruption-skip — catch `StateCorruptionError` and `continue`
the scan; re-throw anything else.

## Regression tests (each verified to fail without its fix)

- **L2** — `tests/unit/cli/execute-with-attach.test.ts`: a read-only open whose
  `awaitForegroundShutdown` returns `{ type: 'action', action: 'retry' }` and
  whose `teardown` throws. Asserts the callback still receives the action reason
  and the command returns `EXIT.OK` (the decided action survives).
- **L3** — `tests/integration/cli/commands/bare-resume-fallback.test.ts`: bare
  `orch resume` with a corrupt **newest** run (unparseable `state.json`, scanned
  first) plus a valid `completed` run. Asserts the scan doesn't throw and the
  fallback is offered for the newest *openable* run, not the corrupt one. Added a
  `writeCorruptRun` helper.

Temporarily reverting both fixes was confirmed to flip exactly these two tests to
`fail` (the L2 callback never fires; the L3 scan throws `StateCorruptionError`),
then restored.

## Verification

- Targeted: `bun test tests/unit/cli/execute-with-attach.test.ts
  tests/integration/cli/commands/bare-resume-fallback.test.ts` → 16 pass.
- Gate: `bun run check` → green (lint + typecheck + unit + mocked-integration +
  two-pane fast + lifecycle + migration parity).

## Notes / issues hit

- The two fixes are independent and small; no scope expansion. L2's "make teardown
  non-fatal" is scoped to the read-only exit branch only — the non-read-only paths
  keep their existing teardown semantics, and no test relied on read-only teardown
  throwing.
- Group 5 is the second-to-last group; **Group 6** (test-rigor: prove
  routing/rendering, not stderr substrings — H1/H2) remains `not-started`.
