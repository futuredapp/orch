# Fix Group 2 — `[r]`/`[c]` actions no longer log a false `tui-crashed` / write "TUI unavailable"

**Status: done**

## What was wrong

The Ink steps-view child exits on `quit`, `retry`, **and** `retry-continue`
(`src/hosts/two-pane/steps-view/steps-view-runner.tsx:136-141`), but the parent only treated
`quit` as a planned stop (`src/hosts/two-pane/steps-view/start-steps-view.ts:160`). When the child
exited after `[r]`/`[c]`, the parent's `stopped` flag was still `false`, so the `childExitPromise`
branch recorded a false `tui-crashed` lifecycle entry **and** enqueued the `TUI_UNAVAILABLE` pane
write — on every retry action. The retry still worked (it resolves through the separate
`shutdownDeferred` channel), so this was log + UX pollution, not a control-flow break.

## What I changed

### Source fix
- `src/hosts/two-pane/steps-view/start-steps-view.ts` — mirrored the child's exit condition in the
  parent's intent handler: `retry` and `retry-continue` now also set `stopped = true`, exactly as
  `quit` already did. Added a comment explaining why the parent must match the child's three
  unmount-triggering intents.

### Test infrastructure
- `tests/_support/fake-host.ts` — added `deferInteractiveResult()` to the `FakeHost`. It makes the
  next `runInteractive` stay pending until the returned resolver is called. This was **necessary**:
  the existing fake resolves `runInteractive` immediately, which is what the existing crash test
  exploits — but it makes the production retry ordering (child writes the intent, *then* exits)
  impossible to reproduce, because the exit branch would fire before the intent is ever tailed. The
  new method lets a test observe the intent first (setting `stopped`), then resolve the child exit.
  The addition is purely additive — the deferred path only activates when `deferInteractiveResult()`
  is called, so no existing consumer is affected (verified: full unit suite green).

### Regression test
- `tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts` — added a parameterized test over
  `retry` and `retry-continue`: emit the intent, let it be tailed/dispatched, then resolve the child
  exit, and assert **no** `tui-crashed` lifecycle entry and **no** `sendKeys` (TUI-unavailable) pane
  write. Confirmed it is a genuine guard: with the source fix reverted, both cases fail (the false
  `tui-crashed` + pane write reappear); with the fix in place, all 12 tests in the file pass.

## Verification

- `bun run lint` — clean (697 files).
- `bun run typecheck` — clean.
- `bun run test:unit` — 1799 pass / 0 fail.
- `bun run test:two-pane:fast` — 266 pass / 0 fail.
- Targeted: `start-steps-view.test.ts` — 12 pass; 2 fail when the fix is reverted (regression proven).

## Notes / issues hit

- The only wrinkle was the immediate-resolution behavior of `FakeHost.runInteractive`, which made a
  faithful test impossible without the small `deferInteractiveResult` seam described above. Extending
  the Host fake (a port-level fake) is consistent with CLAUDE.md rule 3 ("mock only at the edge").
- Stayed within the acceptance contract — this is Codex Finding 3, a reliability/log-correctness fix;
  no behavior visible to AT-R1/AT-R3 changes (the retry path already worked via `shutdownDeferred`).

## Remaining

Groups 3–6 of `fix-plan.md` are still `not-started`.
