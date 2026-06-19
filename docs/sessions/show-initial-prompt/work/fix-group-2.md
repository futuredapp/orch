# Work summary — Group B (Replay fallback must read the prompt-bearing file from the start)

## What was wrong

`resolveAutonomousReplaySpec` (`src/hosts/two-pane/pane-map/right-pane-controller.ts`)
prepended the `prompt:` preamble to the warm-cache fallback file, but both fallback
returns handed back a plain `{ kind: 'file-tail', path: filePath }` — **without**
`fromStart: true`. The primary (frozen-tee) branch already set it. Because
`commandForSpec` maps `fromStart !== true` to the bounded `tail -n 5000 -F`, a
logger-disabled or cancelled-run replay whose prompt + transcript exceeds
`TAIL_BACKFILL_LINES` (5000) would drop the prepended `prompt:` head — violating
R2 (no truncation) and R8/AT-7 (live↔replay parity), and diverging from the
primary branch (KTD8).

## What I changed

`src/hosts/two-pane/pane-map/right-pane-controller.ts`
- Added `fromStart: true` to **both** fallback returns in
  `resolveAutonomousReplaySpec`:
  - the `step.transcriptPath === undefined` branch (no transcript recorded), and
  - the rendered-transcript branch.
- Added a comment explaining why from-start is required (head backfill regardless
  of stream length), mirroring the primary branch.

No other production behavior changed — the primary branch was already correct and
is untouched, so there is no double-display risk.

## Tests added

`tests/model/controller/right-pane-replay-prompt-fallback.test.ts` (model/controller
layer, `FakeTmuxService` seam — no `mock.module`):
- Extracted a `tailCommand` / `tailLinesArg` helper alongside the existing
  `tailedPath`, reading the `-n <lines>` argument off the spawned `createSession`
  command.
- **New:** asserts the rendered-transcript fallback spawns `tail -n +1`
  (from-start), not `tail -n 5000`, when a persisted prompt is present.
- **New:** asserts the no-transcript fallback (`transcriptPath === undefined`) also
  spawns `tail -n +1` and that the warm-cache file leads with the rendered prompt
  preamble.
- The existing "primary branch not double-prefixed" test stays green (primary path
  untouched).

Red/green verified: with the production fix stashed, both new tests fail
(`tailLinesArg` returns `5000`); with the fix in place all 4 tests pass.

## Issues hit

- `bun run check` reported one failure at the gated **real-tmux** level:
  `tests/integration/real-tmux/predictable-fake-f2.test.ts` ("delivers each branch
  only its own type_and_send text"). This is a parallel-branch control-channel test
  unrelated to the replay-fallback change. It **passes cleanly when run in
  isolation** — it is the known real-tmux suite flakiness under concurrent suites
  (leaked puppet daemons / poisoned timing budgets), not a regression from this
  group. All unit + mocked-integration levels are green (490 pass / 0 fail).

## Status

Group B → `done`. Remaining: Groups C, D, E still `not-started`.
