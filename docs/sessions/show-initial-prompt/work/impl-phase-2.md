# Phase 2 — implementation report

**Feature:** Show the Initial Prompt in the Right Pane (Non-Interactive Runs)
**Phase:** 2 — Always-on prompt persistence + replay parity (R8 / AT-7 acceptance)
**Status:** done · both units (U5, U6) implemented and verified.

## What shipped

Phase 1 embedded the prompt preamble into the per-step render tee, so replay
showed the prompt *only when file logging was on* (an interim regression). Phase
2 closes **R8 / AT-7 acceptance**: the assembled prompt now survives on an
**always-on** path independent of the optional file logger, and the replay
**fallback** branch reconstructs the preamble from it.

### U5 — always-on per-step prompt sink (`src/hosts/two-pane/prompt-store.ts`, new)

- `createPromptStore(stateDir)` writes the **raw** assembled prompt to a
  deterministic per-step artifact rooted in the run's `stateDir` —
  `agents/<step>/prompt.txt` — **not** under `logger.logsDir`. Rooting in
  `stateDir` is exactly what makes R8 hold when `logsDir === null` (KTD7).
- The store keeps the body **verbatim** (no escaping/marking — those are display
  concerns in `prompt-preamble.ts`), so a future display change is never a
  storage migration. Idempotent per step (truncate-on-write), consistent with a
  retried/fork-resumed step overwriting with the original prompt (KTD5).
- `readPersistedPrompt(stateDir, step)` reads it back for the replay fallback;
  `NULL_PROMPT_STORE` for fixtures with no `stateDir`. The prompt body is never
  put into `state.json`.
- **Choreographer wiring** (`lifecycle-choreographer.ts`): a `promptStore` dep on
  `LifecycleChoreographerDeps`; at autonomous `step:start` it writes the raw
  prompt **unconditionally** (independent of `teePathFor`/the logger), guarded
  only by the existing autonomous-only early-return + the same
  prompt-present check the preamble uses. Interactive / `command` / `ask` steps
  write no sink.
- **Host wiring** (`tmux-host.ts`): `BuildHostDeps.promptStore`; constructed at
  the `buildHost` call as `createPromptStore(${basePath}/${runId})` when a
  `basePath` exists, else `NULL_PROMPT_STORE`. Threaded into the choreographer.
- Tests: `tests/unit/hosts/two-pane/prompt-store.test.ts` (real-fs: stateDir
  root, raw-verbatim incl. control/non-ASCII bytes, idempotent overwrite, null
  read) + choreographer unit additions (raw persist; persists even when
  `logsDir === null`; no sink for interactive). Recording collaborators gained a
  recording `promptStore`.

### U6 — replay fallback prepends the persisted prompt (`right-pane-controller.ts`)

- Only the **fallback** branch of `resolveAutonomousReplaySpec` changed. It now
  reads `readPersistedPrompt(opts.stateDir, step)` and prepends
  `renderPromptPreamble(prompt)` to the re-rendered transcript (and to the
  "no transcript recorded" placeholder) before writing the warm-cache replay
  file.
- The **primary** branch (frozen `formatted_output.ansi`, size > 0) is left
  untouched — it already embeds the preamble from Phase 1 — so the prompt is
  never double-displayed.
- Test: `tests/model/controller/right-pane-replay-prompt-fallback.test.ts`
  (real-fs, FakeTmuxService seam): (a) AT-7 logging-disabled — no logger ⇒
  fallback ⇒ the tailed warm-cache file leads with the preamble above the
  re-rendered transcript; (b) tee-present ⇒ primary branch tails the tee, no
  `.replay` file is written, prompt appears once.

## Verification

Real tmux 3.6a available, so the `:full:fake` level **actually executed**.

- `bunx tsc --noEmit` — clean
- `bunx biome check` (touched files) — clean
- `bun test tests/unit/hosts/two-pane/prompt-store.test.ts …/lifecycle-choreographer.test.ts` — 22 pass
- `bun test tests/model/controller/right-pane-replay-prompt-fallback.test.ts` — 2 pass
- `bun run test:unit` — 1916 pass (was 1909; +7)
- `bun run test:two-pane:fast` — 289 pass (was 287)
- `bun test tests/integration/hosts` — 37 pass (host wiring)
- `bun run test:two-pane:full:fake` — 18 pass (Phase 1 scenarios still green through real tmux; the live path now also writes the prompt store without regression)

I did **not** run the full `bun run check` (it pulls in the entire e2e +
real-CLI matrix); the slices above cover every file Phase 2 touched.

## Issues & surprises

1. **Recording collaborators: `method: 'write'` is now ambiguous.** Adding a
   `promptStore.write` recorded call collided with the existing `tee.write` on
   the `method` discriminant. Existing choreographer tests that did
   `calls.find(c => c.method === 'write')` then accessed `.payload` no longer
   type-checked (the union now includes the promptStore variant without
   `payload`). Fixed by narrowing those finds/filters to `c.on === 'tee'`. No
   behavioral change — purely a discriminant tightening.

2. **R8's logger-disabled path has no full-host AT (by design).** `logsDir ===
   null` is unit-fixture-only in production (`src/cli/deps.ts`, the full-host
   harness always logs), so AT-7's always-on acceptance is proven by the focused
   model/controller fallback test, not a full-host scenario — exactly as the plan
   (Risks) and acceptance appendix call out. The full-host AT-7 remains the
   logging-on regression.

## Not in this phase (left for Phase 3)
- **Phase 3 (R9 / AT-9):** pin the pane to the top of the prompt at step open
  (tmux copy-mode across `swap-pane`). Still `Status: not-started`.

No blockers raised. No tasks were `blocked-on-user-input`.
