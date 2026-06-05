# Migration ledger — old → new accounting (D15)

> **Per-CASE accounting.** A file is wrapped `.skip` only once **every** child
> `it()`/`test()`/`it.each` row is mapped here to a disposition. Every row is
> keyed to the **frozen** baseline (`baseline.json`, D12). `oldTestRefs` on the
> new scenario must back-reference the old case so the U14 reconciliation closes
> the loop.
>
> **Dispositions:** `port` (re-derived 1:1-ish), `merge` (folded into another
> scenario), `demote` (moved to a cheaper category — e.g. full-host → screen),
> `drop` (deleted with reason — a vacuous/unprovable assertion), `new` (born in
> `tests-new/` with **no** baseline twin — tagged so reconciliation does not flag
> it as an unaccounted relocation; parent §U3 during-migration routing rule).
>
> **Status (parent U4 — migration tracer).** U4 migrates the first two feature
> areas (`launch` + `follow-live`) end-to-end and is the first phase to mark old
> files `.skip`. The overlap report is **blocking** as of U4. The eight
> wholly-in-area old files below are now fully skipped with `// MIGRATED →`
> markers; every child case has a row. Multi-area files (bulk left-pane
> rendering, pane-map/right-pane-controller, the behavioral-dsl launcher smoke)
> stay live for U5–U8 — skipping them before every case is ledgered is the
> green-but-incomplete trap D15 exists to prevent.
>
> **K2 vs K2-alt (parent U4 §4).** The phase took the **K2** path: the
> `single-pane-steps-entry` was made interactive (holds `view` in state, updates
> from `onIntent`), so `selectStep`/`followLive` drive a real selection change
> over real tmux on the `screen` driver — the footer-flip twin uses genuine
> navigation, not a synthetic `viewMode`.

## Migrated cases — `launch` + `follow-live` (parent U4)

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F after navigating to a past step swaps right pane back to the live source | full-host/fake-agent/follow-live--keypress-during-stream.test.ts (+ model/follow-live--returns-to-running-step.test.ts) | port | Deferred placeholder (it.skip): the live-driven scriptedFake submode is the paused-workflow hook it waited for; now a real mid-stream interleave. |
| tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts | after the workflow completes, the left pane renders the terminal-state footer and the workflow name | screen/follow-live--footer-flips-live-to-replay.test.ts (+ screen/launch--header-and-step-list-render.test.ts) | demote→screen | Terminal-state footer + workflow-name render is a byte-level risk (screen), not full-host plumbing (§6). |
| tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts | right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear | full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (+ follow-live--keypress-during-stream.test.ts) | port | Autonomous transcript reaching the visible right pane with no caret echo — two-pane communication risk (full-host). |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | live mode renders '▶ live · ⏎ view step · q quit · ? help' | screen/follow-live--footer-flips-live-to-replay.test.ts | demote→screen | Live-footer bytes (assertFollowLiveHintHidden) — proven off real tmux, not a projection. |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | replay mode renders '⏸ viewing <stepName> · f live · ⏎ view another' | screen/follow-live--footer-flips-live-to-replay.test.ts | demote→screen | Replay-footer bytes (assertFollowLiveHintVisible) — proven off real tmux. |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | flipping state from live → replay re-renders the footer indicator | screen/follow-live--footer-flips-live-to-replay.test.ts | port→screen | The flip is now driven by REAL navigation (selectStep → replay, followLive → live), a stronger assertion than swapping a prop. |
| tests/integration/hosts/two-pane/follow-live-prefers-live-over-interactive-replay.integration.test.ts | after entering a past interactive step replay, pressing follow-live swaps the visible slot back to the live autonomous source | model/follow-live--prefers-live-over-interactive-replay.test.ts | port→model | Follow-live-over-replay is a controller DECISION, re-derived at the projection seam (no tmux). |
| tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts | renders workflow name, step row, and live-mode footer in the left pane | screen/launch--header-and-step-list-render.test.ts (+ model/launch--header-and-step-list-render.test.ts; lifecycle boot → lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) | demote→screen | Header/step-row/footer is rendering bytes (screen) + projection (model); the lifecycle boot/teardown concern keeps its own scenario (§6, K4). |
| tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts | shows the running glyph on the first step and the live source in the right pane | model/launch--first-step-running-and-highlighted.test.ts + screen/launch--first-step-running-and-highlighted.test.ts + full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (+ lifecycle boot) | port | One old case splits by risk: glyph+highlight (model), glyph bytes (screen), live source in right pane (full-host), boot (lifecycle). |
| tests/integration/lifecycle/launch.interactive-badge-renders-on-interactive-step.behavioral.real.test.ts | renders the interactive glyph on an interactive step | — | drop | Blocked `it.todo` that never executed (scripted-fake has no interactive mode); asserted nothing. Re-derive when an interactive/PTY-capable fake runner exists (parent U9/recorded). |

## Backfill — U2/U3 tracers that already pointed at migrated baseline files

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F after navigating to a past step swaps right pane back to the live source | model/follow-live--returns-to-running-step.test.ts | port | U1 model tracer (the `follow-live-view-mode` model member); shares the case ported above — its model half. |
| tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts | after the workflow completes, the left pane renders the terminal-state footer and the workflow name | screen/follow-live--footer-renders-with-quit-hint.test.ts | demote→screen | U2 screen tracer (the `follow-live-view-mode` screen twin); quit-hint footer bytes, same case demoted above. |
| tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts | right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear | full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts | port | U2 full-host tracer; the same right-pane-content case ported above.

## Born-new (no baseline twin) — parent U3 tracers

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| — | — | full-host/recorded-agent/claude-plan-then-work.test.ts | new | born in tests-new/ (parent U3 tracer); no old twin — realistic-event replay had no equivalent under the old harness |
| — | — | full-host/real-agent/autonomous-multi-step.test.ts | new | parent U3 real-CLI smoke; re-derives the spirit of tests/e2e/tier-4 as a two-pane pane-integration assertion, not a runner-isolation test |
