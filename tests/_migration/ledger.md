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

> **Note (parent U9/W4).** The U3 `full-host/real-agent/autonomous-multi-step.test.ts`
> smoke was born `new` but is, in substance, the re-derivation of the tier-4
> `autonomous-multi-step` case. U9 retargets its `oldTestRefs` to the specific old
> file and reclassifies it as a `port` in the tier-4 section below — so the case
> maps to exactly one disposition (no double-count).

## Migrated cases — left-pane logic & rendering (parent U5a)

> **Phase 5 / U5a** re-derives the left-pane *interaction & rendering* cluster
> (selection, preview cursor, scroll/viewport, step glyphs + colour) as `model`
> projection scenarios with co-landed `screen` byte twins under shared
> `overlapGroup`s. Two files are **fully** ported and now `.skip`; the rest are
> **spans/partial** — their U5a cases are ledgered here but the FILE stays live
> until its remaining (footer/banner/summary → U5b; pure-projection → U10–U13;
> failed/pending/interactive/cached colour → U8/U10–U13) cases land. Skipping a
> file with un-ledgered children is the green-but-incomplete trap D15 forbids.

### Fully ported → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/selection.test.tsx | auto-tracks the live step on first render with isUserDriven=false | model/selection--auto-tracks-live-and-browses.test.ts (+ screen/selection--highlight-bytes.test.ts) | port | Committed highlight auto-tracking the live step is a projection decision; byte twin proves the `▌` highlight renders. |
| steps-view/selection.test.tsx | moves selection up when the user presses arrow-up and flips isUserDriven=true | model/selection--auto-tracks-live-and-browses.test.ts | port | `browseTo` drives a real ↑ keystroke and asserts the preview cursor moved while committed held. |
| steps-view/selection.test.tsx | moves selection down when the user presses arrow-down | model/selection--auto-tracks-live-and-browses.test.ts | merge | `browseTo` is bidirectional — it emits ARROW_DOWN when the target row is below the cursor; the down branch is exercised by the same affordance. |
| steps-view/selection.test.tsx | snaps back to live and clears isUserDriven when the user presses f | model/selection--auto-tracks-live-and-browses.test.ts | port | `followLive` snaps the committed selection back to the live step. |
| steps-view/preview-cursor.test.tsx | moves a distinct preview cursor on ↑ while leaving the committed highlight on the live step | model/preview-cursor--browse-commit-snap.test.ts (+ screen/preview-cursor--bytes.test.ts) | port | The `›` preview cursor moves while the `▌` committed row holds — proven at the seam and off real tmux. |
| steps-view/preview-cursor.test.tsx | does not draw a preview cursor when it coincides with the committed row | model/preview-cursor--browse-commit-snap.test.ts | merge | The driver's `previewCursorStepName` vs `highlightedStepName` split depends on the suppression; after `followLive` the cursor returns to the committed row and no separate `›` is reported. |
| steps-view/preview-cursor.test.tsx | commits the previewed step (not the committed row) on Enter | model/preview-cursor--browse-commit-snap.test.ts (+ screen twin) | port | `selectStep` previews then commits the chosen step. |
| steps-view/preview-cursor.test.tsx | snaps the preview cursor back to the committed row on f | model/preview-cursor--browse-commit-snap.test.ts | port | `followLive` snaps preview+committed back together. |

### Spans / partial — case ledgered in U5a, file stays LIVE

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-scroll.test.tsx | (viewport-window scroll cases) | model/scroll--viewport-follows-window.test.ts (+ screen/scroll--window-bytes.test.ts) | port | Off-window step scrolls into view and back to the live tail (model window + screen bytes). The file's footer/scroll-indicator cases route to U5b — file stays live. |
| steps-view/steps-view-colors.test.tsx | renders a green check for completed steps | model/glyph--state-and-color.test.ts (+ screen/glyph--state-and-color-bytes.test.ts) | port | `done` → ✓ green, asserted via the co-located COLOR token (D-P4) on both fidelities. |
| steps-view/steps-view-colors.test.tsx | renders a yellow half-circle for running steps | model/glyph--state-and-color.test.ts (+ screen twin) | port | `running` → ◐ yellow (D-P4). |
| steps-view/steps-view-colors.test.tsx | (red-cross / dim-pending / cyan-selection / preview-chevron / interactive / cached / stripAnsi-structure cases) | — | →U8/U10–U13 | failed-glyph colour belongs to the failure cluster (U8); selection-cyan/preview-chevron/pending/interactive/cached and the stripAnsi structural snapshot are per-status render cases the U5 spec does not yet express — file stays LIVE, deferred. |
| steps-view/adaptive-columns.test.ts | hides elapsed below width 70 and exposes it from 70 upward across the canonical breakpoints | screen/columns--elapsed-threshold.test.ts | port→screen | Adaptive-column hide/show is a render byte risk (elapsed `500ms` drops below 70), proven off real tmux. |
| steps-view/adaptive-columns.test.ts | exposes the documented threshold constants … | — | demote→unit | Pure `COLUMN_THRESHOLDS` policy assertion (D-P6) — relocates as a plain unit test in U10–U13; file stays live. |
| steps-view/steps-view.test.tsx | keeps hairlines and drops the elapsed column on narrow terminals (<70 cols) | screen/columns--elapsed-threshold.test.ts | port→screen | The narrow-width column drop is covered by the screen columns twin. Remaining steps-view.test.tsx cases (header/keymap/end-of-run footer/banner/onKey) span U5b + key-mechanics — file stays live. |

## Migrated cases — view-mode footer · banner · end-of-run (parent U5b)

> **Phase 5 / U5b** re-derives the rendering-dominant cluster (view-mode footer
> hints, banner paint + virtual-clock TTL, end-of-run summary/footer/count/colour).
> Banner TTL is `model`-only on the virtual clock (D-P2 — a `screen` test must
> never wait wall-clock); every other behaviour co-lands a `model` decision and a
> `screen` byte twin under a shared `overlapGroup`. Four steps-view files + one
> tier-1 integration case are fully covered and now `.skip`. The larger
> `steps-view-banner.test.tsx` (Esc/help keymap mechanics) and the pure
> `tui-overlay.test.ts` parser stay live (deferred — see below).

### Fully ported → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/banner-rendering.test.tsx | info banner text appears in the frame | model/banner--info-and-error-paint.test.ts (+ screen/banner--paint-bytes.test.ts) | port | Info banner text paints (decision + bytes). |
| steps-view/banner-rendering.test.tsx | error banner text appears in the frame | model/banner--info-and-error-paint.test.ts (+ screen twin) | port | Error banner paints in the `! … · Esc dismiss` envelope. |
| steps-view/banner-rendering.test.tsx | no banner field → no banner row in the frame | model/banner--info-and-error-paint.test.ts | port | Pre-emit `assertContentAbsent` proves no banner row. |
| steps-view/end-of-run-footer.test.tsx | completed terminal status shows the run-completed footer | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertTerminalFooterVisible('completed')`. |
| steps-view/end-of-run-footer.test.tsx | failed terminal status shows the run-failed footer | model/end-of-run--summary-colors.test.ts | port | `assertTerminalFooterVisible('failed')`. |
| steps-view/end-of-run-footer.test.tsx | crashed terminal status shows the run-crashed footer | model/end-of-run--summary-colors.test.ts | port | `assertTerminalFooterVisible('crashed')`. |
| steps-view/end-of-run-footer.test.tsx | pre-terminal (status: live) keeps the live footer indicator | model/footer--view-mode-hints.test.ts (+ screen twin) | port | Live mode shows the view-step/help hints, no `f live`. |
| steps-view/end-of-run-summary.test.tsx | repaints the header into a summary block on completion (totals + duration) | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertEndOfRunSummaryShows('duration')` + completion count. |
| steps-view/end-of-run-summary.test.tsx | renders distinct labels for failed and crashed terminal states | model/end-of-run--summary-colors.test.ts | port | Failed/crashed footers + summary colours co-asserted. |
| steps-view/end-of-run-summary.test.tsx | leads with "q to quit · ⏎ to inspect" and includes the run status | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertTerminalFooterVisible` pins the co-located footer copy. |
| steps-view/end-of-run-summary.test.tsx | keeps Enter wired so resume on a past interactive step still fires onIntent | model/end-of-run--summary-and-count.test.ts | port | `selectStep` commits in the terminal state. |
| steps-view/end-of-run-summary.test.tsx | renders the same frame on a re-render with an unchanged terminal state (no flicker) | — | drop | Re-render stability is a React-memo concern; the deterministic capture is already stable and flicker hygiene (clearTerminal inspection) is not expressible at the projection seam — covered structurally by the stable byte twin. |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "completed" label in green | model/end-of-run--summary-colors.test.ts (+ screen twin) | port | `assertSummaryColor('completed')` via the co-located COLOR token (D-P4). |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "failed" label in red | model/end-of-run--summary-colors.test.ts (+ screen twin) | port | `assertSummaryColor('failed')`. |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "crashed" label in red | model/end-of-run--summary-colors.test.ts | port | `assertSummaryColor('crashed')`. |
| steps-view/end-of-run-summary-colors.test.tsx | does not color the run header text (only the status word) | model/end-of-run--summary-colors.test.ts | merge | `assertSummaryColor` targets the status word; the co-located COLOR maps only glyph/summary states, so the header breadcrumb carries no colour token — the positive assertion is the spec. |
| tier-1/end-of-run-summary-visible.real.integration.test.ts | left.capture() contains `run completed` footer and `steps 1/1 completed` summary | screen/end-of-run--summary-and-count-bytes.test.ts | demote→screen | Left-pane end-of-run bytes are a single-pane `screen` risk, not full-host plumbing. |

### Spans / partial — case ledgered in U5b, file stays LIVE

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-banner.test.tsx | renders ▶ live · ⏎ view step · q quit · ? help in live mode (no `f live` token) | model/footer--view-mode-hints.test.ts (+ screen twin) | port | Live footer hints + `assertFollowLiveHintHidden`. |
| steps-view/steps-view-banner.test.tsx | renders ⏸ viewing <stepName> · f live · … in replay mode | model/footer--view-mode-hints.test.ts (+ screen twin) | port | `assertViewingHintVisible` + `assertFollowLiveHintVisible` after a real selection change. |
| steps-view/steps-view-banner.test.tsx | renders an info banner above the steps grid | model/banner--info-and-error-paint.test.ts (+ screen twin) | merge | Same info-banner paint behaviour. |
| steps-view/steps-view-banner.test.tsx | renders an error banner with an Esc-dismiss hint | model/banner--info-and-error-paint.test.ts (+ screen twin) | merge | The `! … · Esc dismiss` envelope is co-located and asserted. |
| steps-view/steps-view-banner.test.tsx | dispatches dismiss-banner for an info banner after ttlMs elapses | model/banner--info-clears-error-persists.test.ts | port | Info auto-clears on the virtual clock (D-P2). |
| steps-view/steps-view-banner.test.tsx | does NOT auto-dismiss an error banner regardless of ttlMs | model/banner--info-clears-error-persists.test.ts | port | Error persists past `advanceTime`. |
| steps-view/steps-view-banner.test.tsx | (truncate long stepName; Esc help-open/closed/no-banner mechanics; info-not-manually-dismissable; seq-restart; keymap list) | — | →U6/U10–U13 | Esc/help keymap mechanics + footer truncation + the seq-restart timer detail are low-level keymap/render concerns the U5 surface does not express; file stays LIVE, deferred. |
| steps-view/tui-overlay.test.ts | (all 11 parse/serialize cases) | — | demote→unit | `parseTuiOverlayLine`/`serializeTuiOverlayLine` are pure model-state codec tests, not left-pane rendering (D-P6/triage) — relocate as plain unit tests in U10–U13; file stays live. |
| lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts | the "step complete" info banner is visible briefly then disappears | model/banner--info-clears-error-persists.test.ts | demote→model | Banner TTL is a decision over time — proven deterministically on the virtual clock, never real wall-clock (D-P2/D-P3). File is a lifecycle-cluster file; left live for U8 to close its boot/teardown concern. |
| lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts | error banner stays visible past the info-TTL and dismisses on Esc (blocked it.todo) | model/banner--info-clears-error-persists.test.ts | demote→model | The persist-past-TTL half is now covered at the model seam; the Esc-dismiss half was a never-executed `it.todo`. File left live for U8. |

## Migrated cases — two-pane plumbing: nav · replay · progression · multi-source (parent U6)

> **Phase 6 / U6** migrates the two-pane *plumbing* surface — behaviours whose
> risk is *what the controller decides about the panes* or *whether the two panes
> communicate* — re-derived across `model` (decisions) and `full-host:fake-agent`
> (communication), plus a `screen` byte twin for the one net-new rendering
> surface (the help overlay). It is a **pruning** re-derivation: several nominal-U6
> files answer "yes" to the triage rule ("would this still pass if the pane were
> empty?") — their risk is orchestration / disk persistence / a race, not the
> panes — so they are `demote→integration` (relocated in U10–U13), file left LIVE.
>
> The new full-host nav/replay/multi-step scenarios run in **static** mode (the
> whole FakeRunner workflow runs to completion, then navigation drives the
> mounted host), which sidesteps the U4 live single-handle multi-step limit.

### Sub-phase U6a — navigation & replay → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/nav.help-overlay-opens-and-closes.behavioral.real.test.ts | ? opens the keymap overlay, Esc closes it, the step list survives | model/help-overlay--opens-and-closes.test.ts (+ screen/help-overlay--paint-bytes.test.ts) | port | New help-overlay affordance (U6a.1): controller-shows decision (model) + overlay bytes paint without eating the step list (screen), overlapGroup `help-overlay`. Closes the U5b-deferred Esc/help keymap mechanics. |
| lifecycle/nav.up-down-moves-selection-without-detaching-live.behavioral.real.test.ts | ↑/↓ moves the preview cursor while the running step keeps live focus | model/nav--up-down-keeps-live-running.test.ts | port→model | Selection decoupled from live focus is a controller decision (no byte risk) — re-derived at the projection seam. |
| lifecycle/nav.enter-on-completed-step-swaps-right-pane-to-transcript.behavioral.real.test.ts | Enter on a completed step swaps the right pane to its transcript | full-host/fake-agent/nav--enter-swaps-right-pane-to-transcript.test.ts | port | Two-pane communication: revisiting a completed step swaps the visible right pane to that step's source (proven via the deterministic per-source `[<step>] starting…` marker; the live↔replay footer-flip chrome is covered by the U5b `view-mode-footer` model/screen scenarios in live mode). |
| lifecycle/nav.f-snaps-selection-back-to-live.behavioral.real.test.ts | f returns the committed selection to the live step | model/follow-live--returns-to-running-step.test.ts (+ model/selection--auto-tracks-live-and-browses.test.ts, U5 footer twins) | merge | Same follow-live decision already covered by the U4 follow-live group; added `oldTestRefs`. No distinct right-pane outcome to warrant a new full-host twin. |
| tier-1/replay-shows-same-transcript-as-live.real.integration.test.ts | the transcript persists in the right pane after the run ends | full-host/fake-agent/replay--revisit-shows-same-transcript.test.ts | port | Single-step transcript persistence is deterministic; two-pane communication. |
| tier-1/replay-revisit-reuses-pane.real.integration.test.ts | the per-source session pane count is stable across two right-pane captures after step:complete | full-host/fake-agent/replay--revisit-shows-same-transcript.test.ts | port (visible) + drop (pane-count) | VISIBLE half (revisit shows the same transcript) ported; the white-box per-source pane-COUNT invariant is `drop` — an implementation detail, not a user-visible outcome, covered structurally by the U2 driver no-orphans/teardown regression. |
| tier-1/multi-step-right-pane-shows-latest.real.integration.test.ts | after the first step completes, the right pane auto-advances to the second live step while the first stays warm-cached | full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | port | Right-pane auto-advance + warm-cache revisit (two-pane plumbing), asserted via the deterministic per-source marker. |
| tier-1/interactive-pane-shows-prompt.real.integration.test.ts | (single it.skip deferred placeholder — never executed) | — | drop | Deferred placeholder (`it.skip`) that never ran and asserted nothing. The interactive *badge* render is covered by U4 `launch.interactive-badge`; real interactive prompt BYTES belong to a U9 `real-agent` smoke if desired. File becomes `describe.skip`. |

### Sub-phase U6b — progression, multi-source, command, demotions

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/progression.live-focus-follows-newly-running-step.behavioral.real.test.ts | the live focus follows the newly-running step after the prior completes | model/progression--live-focus-and-glyph-flip.test.ts | port→model | Controller decision: committed selection auto-tracks the newest running step (overlaps U5 selection-auto-tracks-live). |
| lifecycle/progression.step-completes-glyph-flips-to-check.behavioral.real.test.ts | a completed step's glyph flips to the done check | model/progression--live-focus-and-glyph-flip.test.ts | port→model | Glyph-flip decision (the colour bytes already have a `screen` twin in U5 `glyph--state-and-color`). |
| tier-1/many-sources-no-split-failure.real.integration.test.ts | runs 6 autonomous steps back-to-back; each lands in its own per-source session and the right pane shows the latest | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port | Consolidated at representative scale (3 sources): each per-source step lands in its own session; right pane auto-advances to the latest. |
| tier-1/many-sources-no-split-failure.real.integration.test.ts | captures different pane content after swapping the visible slot across six sources | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port | Swapping the visible slot shows each source's distinct content. |
| lifecycle/per-source-sessions-10-step-walkthrough.real.test.ts | runs 10 autonomous steps; no pane-spawn-failed or scratch-window-rotate events fire; teardown reaps every per-source session | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port (swap) + merge (no-leak/teardown) | The visible swap-across-sources is ported (at 3-source scale, not a slow 10-step real-tmux run); the no-split/no-leak/teardown-reaps property is already guaranteed by the U2 driver no-orphans/teardown regression — referenced, not duplicated. |

### Sub-phase U6b — triage demotions (file left LIVE for U10–U13 relocation)

> These cases answer **yes** to the triage rule ("would this still pass if the
> pane were empty / wrong / unformatted?") — their risk is stop-channel
> coordination, disk persistence, resume orchestration, or a race, NOT two-pane
> rendering. They are `demote→integration` and **relocated in U10–U13**; U6
> leaves each file **LIVE** (capability `skipIf` unchanged), because reconcile
> rule 3 forbids a `// MIGRATED →` marker pointing at a target that does not yet
> exist. U6 must not skip these.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tier-1/auto-stop.real.integration.test.ts | closes itself when the stop channel is signaled, with no manual close | → U10–U13 | demote→integration | Stop-channel coordination, not rendering — passes if the pane is empty. File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | records armed → signaled → terminated lifecycle events in order | → U10–U13 | demote→integration | Stop-channel event ordering (host-coordinator integration with fakes). File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | resolves via pane-exit when an armed autoStop pane is manually closed, with no stop signal | → U10–U13 | demote→integration | Pane-exit race coordination, not a visible pane outcome. File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | a step without autoStop never arms and ignores a stop-channel signal | → U10–U13 | demote→integration | Negative stop-channel coordination. File stays LIVE. |
| lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts | writes session.json and events.ndjson for each completed step | → U10–U13 | demote→integration | Disk persistence, not rendering — passes if the pane is empty. File stays LIVE. |
| lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts | cached plan survives across runs; execute re-runs and the resumed run completes | → U10–U13 | demote→integration | Resume orchestration (cached-plan survival, runner re-invocation). The cached-glyph RENDER overlaps U8 cached-colour; the orchestration is the dominant risk. File stays LIVE. |
| lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts | command stdout streams to disk and state.json records exitCode 0 | → U10–U13 | demote→integration | The OLD case asserts disk streaming + `state.json` exitCode — both persistence/orchestration ("passes if the pane is empty"). The full-host harness runs agent steps only; a non-agent command step that streams to the right pane needs host-fixture infrastructure (a `command(...)` step + tmux pipe-pane capture) that does not exist in `tests-new/_support/real-tmux/` and is beyond U6's scenario-authoring scope. The visible command-output-to-pane behaviour is deferred to whichever phase adds command-step support; the persistence assertion relocates in U10–U13. File stays LIVE. |

## Migrated cases — right-pane-controller / pane-map decisions (parent U7a + U7b)

> **`model/controller` is a non-`scenario()` category** (the `tmux-argv` precedent;
> see `tests-new/model/controller/README.md`). These cases assert controller
> DECISIONS at the `FakeTmuxService` seam — which session to swap to, what to
> write to the overlay, when to refuse to swap to a dead pane — and pass with an
> empty pane (triage rule answers **yes**). They are therefore plain `it()` tests,
> not `model`/`screen`/`full-host` scenarios, and carry no `scenario()` meta or
> `oldTestRefs` for the overlap report to check; this ledger is their accounting.
> Every relocated file imports the **same `src/` symbols** as its baseline
> original (import-path parity, parent R10). All cases ported faithfully; no
> regression-pin run-ID was pruned. The visible-swap *outcomes* these decisions
> drive were already re-derived as U6 full-host scenarios (see U7d merges below).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| pane-map/right-pane-controller.test.ts | (all 20 cases: registerSource ×5, showSource ×4, unregisterSource ×3, follow-live auto-advance ×1, teardownSessions ×2, followLive ×3, concurrent registerSource race ×2) | model/controller/right-pane-controller-sources.test.ts (registerSource/showSource/unregisterSource) **+** model/controller/right-pane-controller-lifecycle.test.ts (auto-advance/teardown/followLive/race) | port | Controller decisions at the `FakeTmuxService` seam. Split into two files because the 700-line original exceeds the repo's 600-line test-file cap; both halves share `right-pane-controller-fixture.ts`. Regression pins r-2026-05-22-170039-0o (race) and r-2026-05-29-104450-sx (auto-advance) preserved. The visible swap is covered by U6 full-host scenarios; the *decision* (which session) stays here. |
| pane-map/right-pane-on-intent.test.ts | (all 8 cases: warm-cache, viewMode-flip, lookup-miss, ANSI-tee preference, follow-live placeholder, live-not-replay, auto-advance-stop, interactive-stays-replay) | model/controller/right-pane-on-intent.test.ts | port | Pure `onIntent('enter')` dispatch decisions. Regression pins r-2026-05-11-215044-tv, r-2026-05-27-154145-nk, r-2026-05-29-104450-sx preserved. |
| pane-map/source-session.test.ts | (all 13 cases: sanitizeSessionName ×7, createSourceSession ×4, teardownSourceSession ×2) | model/controller/source-session.test.ts | port | Pure helper logic (relocation + import fix only). |
| pane-map/right-pane-controller-banner.test.ts | (all 6 cases: emitBanner ×3, setViewMode ×1, dismiss-banner ×2) | model/controller/right-pane-controller-banner.test.ts | port | Controller wire-format DECISION (what it writes to the overlay) — distinct from the overlay *codec* parse/serialize tests, which are U10–U13. |
| pane-map/right-pane-controller-failure-recovery.test.ts | (all 4 cases: Bug B stderr-bleed ×2, Bug C suppressCompletionBanner ×2) | model/controller/right-pane-controller-failure-recovery.test.ts | port | Error-containment decisions. Regression pins r-2026-05-21-141104-5n (Bug B) and r-2026-05-22-135756-tc (Bug C) preserved. |
| pane-map/right-pane-controller-session-lost.test.ts | (all 4 cases: register throws + no bleed, no ghost entry, unregister no bleed, canonical macOS error shape) | model/controller/right-pane-controller-session-lost.test.ts | port | Error-containment decisions. Regression pin r-2026-05-22-093650-j0 preserved. |
| pane-map/right-pane-controller-interactive-dead-pane.test.ts | (all 4 cases: no-swap to dead resume pane, swap-failure→error banner, no-swap on follow-live, recover by re-register) | model/controller/right-pane-controller-interactive-dead-pane.test.ts | port | Dead-pane decisions asserted at the fake's ownership seam (passes with an empty pane) — NOT full-host. Regression pin r-2026-05-25-171216-nu preserved. |
| pane-map/right-pane-controller-replay-dead-pane.test.ts | does-not-swap to the dead pane of a torn-down per-source session (1 case) | model/controller/right-pane-controller-replay-dead-pane.test.ts | port | Same dead-pane decision class. Regression pin Issue 3 preserved. |
| pane-map/resume-refusal.test.ts | (all 10 cases: R10, R8, R11, unsupported-runner, R9 ambiguous/empty/error, defensive no-sessionId, happy path, F6 step-keyed lookup) | model/controller/resume-refusal.test.ts | port | Branch-selection decisions. Regression pins R8–R11 / R9 / F6 preserved. |

## Migrated cases — subworkflow surface (parent U7c)

> **Triage applied per case, not per the directional table.** The old subworkflow
> tests are NOT tmux-tier tests — they are plain component/hook/projector tests
> (`projectStepsView` on pure data, `useStepsSelection` via ink-testing,
> `renderToString(<StepsView>)`). They relocate faithfully into the non-`scenario()`
> `model` / `model/projector` categories (the `tmux-argv` / `model/controller`
> precedent), needing no new scenario/driver affordances. **Scoped deviation from
> U7c.1's affordance plan:** boundary-row emission and parallel-suppression are
> proven at the projector seam (the row IS emitted); boundary-selection is a
> selection DECISION over `useStepsSelection`; the collapse gutter is the one
> genuine *rendering* case and is proven by a synchronous `renderToString` frame
> assertion. A `screen` byte twin (and the new `LeftPane`/`PaneDriver` collapse
> affordance + `overlapGroup: subworkflow-collapse`) was intentionally **not**
> built: it would add terminal-grid fidelity to a width-driven gutter that
> `renderToString` already exercises, at the cost of a risky shared-DSL extension
> touching every driver. The behaviours are fully covered; only the heavier
> scenario/byte-twin packaging is deferred (a later phase may add the screen twin
> if real-tmux gutter fidelity is ever in doubt).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/subworkflow-boundary-projection.test.ts | (all 8 cases: ▼/✓ between parents, additive gutter stacking, deepest-first close, in-flight stepless ▼, ✗ terminal synthesis, summary-total exclusion, sibling same-leaf separation, live-overlay subPath) | model/projector/subworkflow-boundary-projection.test.ts | port | Pure `projectStepsView` invariants on pure data. The ▼/✓ boundary-row *emission* (the row appearing) is proven here at the projection seam; no separate `model` render twin is needed (renders only what the projector emits). |
| steps-view/applySubworkflowEvent.test.ts | (all 3 cases: full-subPath keying, insideParallel preservation, invalid-event rejection) | model/projector/applySubworkflowEvent.test.ts | port | Pure fold logic (relocation + import fix). |
| steps-view/subworkflow-parallel-suppression.test.ts | suppresses sub-of-parallel (AE9); suppresses transitively (AE13); does NOT suppress sequential (negative control) | model/projector/subworkflow-parallel-suppression.test.ts | port | The 3 pure-projector suppression invariants. |
| steps-view/subworkflow-parallel-suppression.test.ts | keeps insideParallel on lifecycle records for suppressed homogeneous sub boundaries | → U10–U13 | demote→integration | Runs a real `parallel()` workflow (`parent.execute(deps)`) and asserts persisted lifecycle records — execution/persistence, NOT projection ("passes if the pane is empty"). **File stays LIVE** (reconcile rule 3: the one demote target does not yet exist). |
| steps-view/subworkflow-collapse.test.tsx | (all 4 cases: compact `│4 ` at width 50/depth 4; depth-4 boundary uses depth-3 compact form; stacked-bar at width 80/depth 4; stacked-bar at depth 3/width 50) | model/subworkflow--collapse-gutter.test.tsx | port | The genuine *rendering* case: a synchronous `renderToString(<StepsView>)` frame assertion of the compact-gutter chrome at the AE12 width/depth conditions. Plain `model` render test (no `scenario()`); the `│N ` token is the co-located spec, asserted directly. |
| steps-view/subworkflow-boundary-selection.test.tsx | (all 6 cases: ↑ skips ✓ exit→child-2; ↓ skips ✓ exit→parent-B; committedName never a boundary; ↑ no-op when only boundaries above; only-boundaries→selected=none; ⏎ on boundary emits no intent) | model/subworkflow--boundary-selection.test.tsx | port | Selection DECISIONS over `useStepsSelection` / `<StepsView>` (read hook state, pass with an empty pane). Plain `model` hook/component test via ink-testing-library. |

### U7d — crossing-panes merges (§7 discovery outcome)

> **No `oldTestRefs` merge into U6 full-host scenarios was required.** The parent
> §4 anticipated splitting some pane-map cases into a `model/controller` *decision*
> half plus a *visible-swap* half that merges into U6's
> `nav--enter-swaps-right-pane-to-transcript` /
> `multi-source--each-source-swaps-distinct-content` /
> `replay--revisit-shows-same-transcript`. In practice every old pane-map case
> asserts a controller decision at the `FakeTmuxService` seam (recorded tmux calls
> / projected state) — there is no separate visible-swap assertion embedded in any
> case to peel off — so each ported whole as a `model/controller` decision (no case
> dispositioned `merge`). The user-visible swap *outcomes* those decisions drive
> are already covered by the three U6 full-host scenarios above; no new full-host
> scenario was needed (the §7 default expectation of zero new full-host scenarios
> held). No U6 scenario file was edited.

## Migrated cases — lifecycle / outside-in (parent U8)

> **Phase 8 / U8** migrates the lifecycle / outside-in surface
> (`tests/integration/lifecycle/`) as a pruning re-derivation across four groups
> (phase plan §2): **G1** process signals/stdin/quit + **G2** click-to-focus →
> `lifecycle` `scenario()`; **G3** failure *rendering* → `model` (+ `screen`/
> `full-host` twin) using the existing `outcome:'failed'` DSL (KD3, no new
> lifecycle pane-reads); **G4** side effects / persistence → the non-`scenario()`
> `tests-new/lifecycle/side-effects/` category (KD1/KD4, the `tmux-argv` /
> `model/controller` precedent). **KD2:** signals/quit assert only the shutdown
> invariants `main` produces — no `persistedStatus('cancelled')`; on current
> `main` no signal/quit persists `cancelled` (Phase 2 finding), and U8 changes no
> source (parent §2 non-goal). The U6-deferred `command`/`progression.per-step-
> artifacts`/`resume` files stay LIVE for U10–U13.

### G1 — process signals / stdin / quit → `lifecycle` `scenario()`, file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/sigint-to-orch-during-mid-step.real.test.ts | exits via documented signal, tears down tmux, and leaves the terminal balanced | lifecycle/sigint--exits-cleanly-and-tears-down.test.ts | port | SIGINT shutdown invariants (exit/tmux-down/terminal-balanced/no-orphans), re-derived on the lifecycle driver (the strengthened U2 ctrl-c tracer). |
| lifecycle/sigint-to-orch-during-mid-step.real.test.ts | (the §9.8-ideal `persistedStatus('cancelled')` sub-claim) | — | drop | The old cell already omits it (documented finding); on `main` SIGINT does not persist `cancelled`. Asserting it would be false; source unchanged per U8 non-goal. `persistedStatus` itself stays covered by the lifecycle driver regression test against a planted state. |
| lifecycle/sigterm-to-orch-during-mid-step.real.test.ts | exits cleanly, tears down tmux, and leaves the terminal balanced | lifecycle/sigterm--exits-cleanly-and-tears-down.test.ts | port | SIGTERM shutdown invariants (KD2). |
| lifecycle/sighup-to-orch-during-mid-step.real.test.ts | exits cleanly, tears down tmux, and leaves the terminal balanced | lifecycle/sighup--exits-cleanly-and-tears-down.test.ts | port | SIGHUP (controlling-TTY hangup) shutdown invariants (KD2). |
| lifecycle/double-sigint-to-orch-during-mid-step.real.test.ts | still reaches the §6.5 signal-sigint clean state after a redundant SIGINT | lifecycle/double-sigint--still-reaches-clean-shutdown.test.ts | port | Redundant-second-SIGINT regression guard; same clean shutdown state (KD2). |
| lifecycle/close-stdin-during-mid-step.real.test.ts | preserves the weak close-stdin contract — terminal stays balanced | lifecycle/close-stdin--terminal-stays-balanced.test.ts | port | The WEAK contract mirrored exactly: settle, then assert only terminal balance — no exit/teardown matcher (orch v1 has no stdin-EOF handler). |
| lifecycle/q-during-fake-mid-step.real.test.ts | tears orch down cleanly — §6.5 pane-q-during-run | lifecycle/q-intent--tears-down-cleanly.test.ts | port | A daemon `quit` intent (via `tui-intents.ndjson`) tears orch down cleanly (exit + tmux gone). |

### G2 — click-to-focus → `lifecycle` `scenario()`, file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/click-to-focus-across-divider-smoke.real.test.ts | clicks move focus between the left and right panes | lifecycle/click-to-focus--moves-focus-across-divider.test.ts | port | Click-to-focus round-trip (right then back to left) via the W1 `click`/`assertFocused` affordances over real tmux — the mouse-event builder + focus matcher. |

### G3 — failure RENDERING → `model` (+ `screen` twin)

> **Reality correction (KD3, applied at implementation time).** The phase plan's
> premise that the two `failure.*` "x-glyph-and-error-banner" /
> "right-pane-failure-summary" lifecycle files assert *pane content* is
> contradicted by the code: both assert durable *on-disk* signals (lifecycle.ndjson
> / persisted state / per-step tee file) because at Tier 5 the pane is torn down
> sub-100ms when the workflow throws (the old files' own comments say the on-pane
> equivalent lives in the in-process tiers). By the decision rule + triage ("passes
> if the pane is empty?" → **yes**), all four `failure.*` files are persistence
> tests and relocate to **G4** (`side-effects/`), not `model`/`screen`. The genuine
> *rendering* gap U8 owns is the **failed-step glyph + colour**, which the U5a
> ledger explicitly deferred from `steps-view-colors.test.tsx` to U8. W4 closes
> exactly that, re-derived via the existing `outcome:'failed'` DSL (no lifecycle
> pane-reads). The error-BANNER rendering was already covered by the U5b
> `banner--info-and-error-paint` model/screen twins.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-colors.test.tsx | renders a red cross for failed steps (the U5a-deferred "red-cross" case, assigned to U8) | model/failure--failed-step-glyph-and-color.test.ts (+ screen/failure--failed-step-glyph-and-color-bytes.test.ts) | port | Failed step row renders ✗ in red — projector decision (model) + bytes survive real tmux (screen), overlapGroup `failure-glyph`. **File stays LIVE** — its remaining per-status render cases (dim-pending / cyan-selection / preview-chevron / interactive / cached / stripAnsi-structure) are still deferred to U10–U13 (U5a ledger). |

### G4 — side effects / persistence → `tests-new/lifecycle/side-effects/` (non-`scenario()`), file `.skip`

> **Non-`scenario()` category** (KD1/KD4, the `tmux-argv` / `model/controller`
> precedent — see `tests-new/lifecycle/side-effects/README.md`). These drive a real
> orch subprocess and assert git / filesystem / persisted-state SIDE EFFECTS with
> zero pane assertions (triage = passes if the pane is empty), at one fidelity with
> no twin. They are plain `it()` tests importing behavioral-dsl from `@orch/test/*`
> (import-path parity, parent R10 — verified to import the same helper symbols as
> their baseline originals), NOT a shared-DSL extension. Includes the four
> `failure.*` files, which assert DISK signals despite two of their names mentioning
> the pane (KD3 reality correction above).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/failure.persisted-state-reflects-failed-status.behavioral.real.test.ts | state.json status=failed, prior steps completed, failed step recorded | side-effects/failure-persisted-state.test.ts | port | Persisted-state side effect; passes with an empty pane. |
| lifecycle/failure.api-error-on-first-turn-keeps-run-failed-not-crashed.behavioral.real.test.ts | CLI emits terminal error + non-zero exit → step.failed, run.failed (NOT crashed) | side-effects/failure-api-error-is-failed-not-crashed.test.ts | port | Graceful-failure persistence. KD5: asserted as observed on `main` (`failed`); the old comment's RED prediction is stale (source since fixed). Source unchanged by U8. |
| lifecycle/failure.failed-step-shows-x-glyph-and-error-banner.behavioral.real.test.ts | puppet fail() emits step:failed in lifecycle.ndjson with the message and ends the run as failed | side-effects/failure-step-failed-recorded-on-disk.test.ts | port | The cell asserts DISK signals (lifecycle.ndjson + persisted state), not pane content — persistence, not rendering (KD3). The named ✗ glyph render → model/screen `failure-glyph` twin; the error banner → U5b banner twins. |
| lifecycle/failure.right-pane-shows-failure-summary.behavioral.real.test.ts | the per-step tee file contains the failure headline and error text | side-effects/failure-summary-written-to-tee.test.ts | port | The cell asserts a DISK side effect (the per-step tee file), not pane content (KD3). |
| lifecycle/commit.step-creates-real-commit-on-branch.behavioral.real.test.ts | git log on the worktree branch shows the commit added by the commit step | side-effects/commit-step-creates-real-commit.test.ts | port | Git side effect (`commitExists`). |
| lifecycle/worktree.creates-real-git-worktree-and-switches-cwd.behavioral.real.test.ts | git worktree list reports the branch and the agent step lands inside it | side-effects/worktree-creates-and-switches-cwd.test.ts | port | Git + fs side effect (`worktreeExists` + file under the worktree path). |
| lifecycle/worktree.post-create-shell-command-creates-file.behavioral.real.test.ts | postCreate ["touch sentinel.txt"] creates the file inside the worktree | side-effects/worktree-post-create-shell-command.test.ts | port | Fs side effect (`fileExistsAt` for the postCreate sentinel). |
| lifecycle/ask.noninteractive-uses-default-and-does-not-block.behavioral.real.test.ts | --noninteractive resolves the ask to its declared default and the next step runs | side-effects/ask-noninteractive-uses-default.test.ts | port | Non-blocking behaviour; persisted state shows both steps completed. |

### W6 — lifecycle-dir close-out: the 4 U5b/U6 rendering strays → file `.skip` (COVERED BY)

> These four files physically live in `tests/integration/lifecycle/` but belong to
> U5/U6's areas (the parent U5 old-sources list names `lifecycle/banner.*` and
> `lifecycle/end-of-run.*`). U5b/U6 built the model/screen/full-host replacements
> but never `.skip`ped these lifecycle copies. Each asserts a DISK signal as a
> teardown-race workaround for an unobservable pane; the rendering they are named
> for is covered by an existing twin (verified before close-out), so each is
> `demote`/`drop` + `// COVERED BY →`. No new twin was needed (no genuine gap).

| Old file | Old case | Covered by (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts | the "step complete" info banner is visible briefly then disappears | model/banner--info-clears-error-persists.test.ts | demote→model | Info-banner TTL auto-clear is a render decision over time, proven on the virtual clock (D-P2). |
| lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts | error banner stays visible past the info-TTL and dismisses on Esc (`it.todo`) | model/banner--info-clears-error-persists.test.ts | drop | Never-executed `it.todo` placeholder (blocked at Tier 5). Persist-past-TTL covered at the model seam; the Esc-dismiss half never ran. File `describe.skip`. |
| lifecycle/end-of-run.right-pane-rests-on-final-step.behavioral.real.test.ts | the final step has a non-empty events.ndjson and session.json on disk | full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | demote | Visible right-pane rest-on-latest covered by the U6 full-host scenario; the disk-artifact half is subsumed by the still-LIVE per-step-artifacts cell (→U10–U13). |
| lifecycle/end-of-run.summary-and-completion-count-visible.behavioral.real.test.ts | all 3 steps complete, run status=completed, lifecycle.ndjson records run-ended | model/end-of-run--summary-and-count.test.ts (+ screen twin) | demote→model/screen | Visible summary + completion count covered by the U5b twins; the persisted-completed / run-ended disk assertion was a teardown-race workaround for the unobservable pane. |

### U8 lifecycle-dir drain (DoD)

> After U8 the **only** LIVE (non-`.skip`) files in `tests/integration/lifecycle/`
> are the three U6-deferred → U10–U13 relocations (reconcile rule 3 forbids a
> `MIGRATED →` marker to a not-yet-existing target):
> `command.output-streams-to-right-pane-and-exit-code-recorded`,
> `progression.per-step-artifacts-land-on-disk`,
> `resume.cached-steps-replay-with-cached-glyph`. Everything else U8 touched is
> `.skip` with a `// MIGRATED →` / `// COVERED BY →` marker and a case-granular row
> above.

## Migrated cases — `tier-4` / real-CLI (parent U9)

> **Phase 9 / U9** closes the two-pane real-CLI surface — the last of group B.
> The three `tests/e2e/tier-4/*` files (one frozen-baseline case each, D12) are
> re-derived through the `full-host:real-agent` driver (gated smokes) and flipped
> from capability-gating (`describe.skipIf(!canRun)`) to **unconditional**
> `describe.skip` (D2) so U14's reconcile reads them as migrated, not merely
> capability-skipped (R5). The interactive/autoStop passthrough (W1) made the
> auto-stop case expressible. `mixed-with-interactive` is a `drop`: a never-run
> `it.skip` placeholder asserting nothing, blocked on interactive-PTY-step harness
> support that still does not exist (deferred follow-up, parent §7 Scope).

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts | two real-CLI autonomous steps run to completion and right.capture() shows live transcript text | full-host/real-agent/autonomous-multi-step.test.ts | port | Re-derived as a two-pane pane-integration smoke: two real Claude steps complete and the second step's transcript paints in the right pane (§9.7). Gated; auto-skips off the gate. |
| tests/e2e/tier-4/auto-stop.real.e2e.test.ts | finishes its turn and the pane closes on its own with no keystroke | full-host/real-agent/auto-stop.test.ts | port | The unique AE2 proof: a real interactive turn auto-stops and paints its reply with NO keystroke — the real Stop-hook + real env + real tmux `wait-for` transport the fake cannot exercise. Unblocked by the W1 mode/autoStop passthrough. Gated. |
| tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts | autonomous step + interactive step share the same harness body | — | drop | Never-executed `it.skip` placeholder that asserted nothing; depends on interactive-PTY-step harness support that does not exist. Re-derive when that helper lands (deferred follow-up). File `describe.skip` with `// DROPPED →`. |

## Born-new (no baseline twin) — parent U9 recorded realism

> Event-stream-*shape* realism the inline `emits(...)` fake cannot produce
> (multi-`tool_use` interleave; an error terminal). Hand-authored cassettes that
> replay deterministically through the fake-agent engine on the real two-pane host
> — no CLI, no network (parent §9.6, D9). Born in `tests-new/`, no old twin.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| — | — | full-host/recorded-agent/multi-tool-use.test.ts | new | born in tests-new/ (parent U9/W3); no old twin — a turn firing several `tool_use` events before its assistant line, a stream shape the inline fake cannot reproduce |
| — | — | full-host/recorded-agent/error-terminal.test.ts | new | born in tests-new/ (parent U9/W3); no old twin — a turn ending on `terminal.type: 'error'`; proves the failure outcome paints (not a hang/crash) |

## Relocated — `core/**` (parent U10)

> **Phase 10 / U10 is a RELOCATION, not a re-derivation (parent D1).** The
> `core/**` tests are already plain class/integration tests with fakes at the
> `*Service` seam — today's `unit` concept *is* the parent's `unit` category.
> Each file below was COPIED to its `tests-new/{unit,integration}/core` mirror
> with its body **byte-identical**; the only edit is the cross-tree helper
> specifier (`../../helpers/{fake-host,temp-git-repo,type-assertions}.ts` →
> `@orch/test/*`, parent D13). Every relocated file imports the **same `src/`**
> **symbols** as its baseline original, machine-verified per file by the new
> `import-parity` guard (`bun run check:import-parity`, parent R10) — so the
> 1:1 case identity D15 requires is preserved by construction, and one `port`
> row per file (the U7a/U7b relocation precedent, PD5) is the accounting. No
> case was split, merged, demoted, or dropped; no `src/` file was touched. The
> old copies are wrapped unconditional `describe.skip` with a `// MIGRATED →`
> marker and kept on disk forever (D2); the two real-CLI files
> (`commit-real`, `worktree-real`) had their OLD copy flipped from
> `describe.skipIf(!canRun)` to unconditional `describe.skip` so U14's reconcile
> reads them as MIGRATED, while the NEW copies keep `skipIf` (legitimate
> capability gating, D8). The 6 core `.test-d.ts` type-tests are **not** in this
> phase — deferred to U13 (PD1); the `_worktree-test-helpers.ts` asset relocated
> with the cluster (its old copy kept so the skipped old tests still resolve).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| unit/core/ask.test.ts | (all 26 cases) | tests-new/unit/core/ask.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/command.test.ts | (all 38 cases) | tests-new/unit/core/command.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/commit.test.ts | (all 13 cases) | tests-new/unit/core/commit.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/derive-step-key.test.ts | (all 8 cases) | tests-new/unit/core/derive-step-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/errors.test.ts | (all 12 cases) | tests-new/unit/core/errors.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/execution-context.test.ts | (all 18 cases) | tests-new/unit/core/execution-context.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/failure-summary.test.ts | (all 8 cases) | tests-new/unit/core/failure-summary.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/interactive-mode.test.ts | (all 11 cases) | tests-new/unit/core/interactive-mode.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-009248-w8, r-2026-04-13-320115-3u, r-2026-04-13-585828-kn preserved. |
| unit/core/parallel-inherits-subworkflow-fields.test.ts | (all 7 cases) | tests-new/unit/core/parallel-inherits-subworkflow-fields.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/parallel.test.ts | (all 26 cases) | tests-new/unit/core/parallel.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/resume-registry.test.ts | (all 6 cases) | tests-new/unit/core/resume-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-mode-tty-guard.test.ts | (all 3 cases) | tests-new/unit/core/run-mode-tty-guard.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-mode.test.ts | (all 17 cases) | tests-new/unit/core/run-mode.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-step-once-collision.test.ts | (all 6 cases) | tests-new/unit/core/run-step-once-collision.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100001-aa preserved. |
| unit/core/run-workflow.test.ts | (all 12 cases) | tests-new/unit/core/run-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-110000-aa, r-2026-05-28-110000-ab, r-2026-05-28-110000-ac, r-2026-05-28-110000-en preserved. |
| unit/core/runner-addressing.test.ts | (all 6 cases) | tests-new/unit/core/runner-addressing.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-06-01-090000-aa preserved. |
| unit/core/schema-validation.test.ts | (all 11 cases) | tests-new/unit/core/schema-validation.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-12-408036-se, r-2026-04-12-935632-9n preserved. |
| unit/core/schema.test.ts | (all 20 cases) | tests-new/unit/core/schema.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/session-id-capture.test.ts | (all 4 cases) | tests-new/unit/core/session-id-capture.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-200000-zz preserved. |
| unit/core/step-lifecycle.test.ts | (all 6 cases) | tests-new/unit/core/step-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/step.test.ts | (all 34 cases) | tests-new/unit/core/step.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/types-step-name-pattern.test.ts | (all 11 cases) | tests-new/unit/core/types-step-name-pattern.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/types.test.ts | (all 11 cases) | tests-new/unit/core/types.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/view-registry.test.ts | (all 8 cases) | tests-new/unit/core/view-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-args.test.ts | (all 6 cases) | tests-new/unit/core/workflow-args.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-031568-o6 preserved. |
| unit/core/workflow-auto-stop.test.ts | (all 7 cases) | tests-new/unit/core/workflow-auto-stop.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-25-000000-aa preserved. |
| unit/core/workflow-name-validation.test.ts | (all 12 cases) | tests-new/unit/core/workflow-name-validation.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-parallel-lifecycle.test.ts | (all 4 cases) | tests-new/unit/core/workflow-parallel-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-resume-registry.test.ts | (all 6 cases) | tests-new/unit/core/workflow-resume-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-13-300000-zz preserved. |
| unit/core/workflow-tmux-guards.test.ts | (all 2 cases) | tests-new/unit/core/workflow-tmux-guards.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-097860-gx preserved. |
| unit/core/workflow-validators.test.ts | (all 10 cases) | tests-new/unit/core/workflow-validators.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8 preserved. |
| unit/core/workflow-vars-cache-key.test.ts | (all 11 cases) | tests-new/unit/core/workflow-vars-cache-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100000-aa preserved. |
| unit/core/workflow.test.ts | (all 26 cases) | tests-new/unit/core/workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8, r-2026-04-13-458000-q8 preserved. |
| unit/core/worktree-executor-cache.test.ts | (all 4 cases) | tests-new/unit/core/worktree-executor-cache.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor-conflicts.test.ts | (all 6 cases) | tests-new/unit/core/worktree-executor-conflicts.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor-postcreate.test.ts | (all 7 cases) | tests-new/unit/core/worktree-executor-postcreate.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor.test.ts | (all 8 cases) | tests-new/unit/core/worktree-executor.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree.test.ts | (all 34 cases) | tests-new/unit/core/worktree.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/cache-key.test.ts | (all 18 cases) | tests-new/unit/core/prompt-file/cache-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/caller-dir.test.ts | (all 9 cases) | tests-new/unit/core/prompt-file/caller-dir.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/load-prompt.test.ts | (all 9 cases) | tests-new/unit/core/prompt-file/load-prompt.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/resolve-prompt-path.test.ts | (all 11 cases) | tests-new/unit/core/prompt-file/resolve-prompt-path.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/step-define-prompt-file.test.ts | (all 12 cases) | tests-new/unit/core/prompt-file/step-define-prompt-file.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/substitute.test.ts | (all 26 cases) | tests-new/unit/core/prompt-file/substitute.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| integration/core/ask-lifecycle.test.ts | (all 2 cases) | tests-new/integration/core/ask-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-22-212450-a1 preserved. |
| integration/core/ask-mocked.test.ts | (all 11 cases) | tests-new/integration/core/ask-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-01-100000-a1, r-2026-05-01-100100-a2, r-2026-05-01-100200-a3, r-2026-05-01-100300-a4, r-2026-05-01-100400-a5, r-2026-05-01-100500-a6, r-2026-05-01-100700-a8 preserved. |
| integration/core/codex-thread-id-capture.integration.test.ts | (all 7 cases) | tests-new/integration/core/codex-thread-id-capture.integration.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-13-100001-cd, r-2026-05-13-100002-cd, r-2026-05-13-100003-cd, r-2026-05-13-100004-cd, r-2026-05-13-100005-cd, r-2026-05-13-100006-cd, r-2026-05-13-100007-cd preserved. |
| integration/core/command-mocked.test.ts | (all 21 cases) | tests-new/integration/core/command-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-100000-c1, r-2026-05-05-100200-c2 preserved. |
| integration/core/command-real.test.ts | (all 8 cases) | tests-new/integration/core/command-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-100000-rl preserved. |
| integration/core/commit-mocked.test.ts | (all 3 cases) | tests-new/integration/core/commit-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-398232-yj, r-2026-04-13-458000-q8 preserved. |
| integration/core/commit-real.test.ts | (all 3 cases) | tests-new/integration/core/commit-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-416112-w6, r-2026-04-13-638488-e2 preserved. |
| integration/core/interactive-workflow.test.ts | (all 2 cases) | tests-new/integration/core/interactive-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-414240-6m, r-2026-04-14-636616-oi preserved. |
| integration/core/parallel-mocked.test.ts | (all 5 cases) | tests-new/integration/core/parallel-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-12-200640-3c, r-2026-04-12-423020-l8, r-2026-04-12-533496-jo, r-2026-04-12-755876-2k, r-2026-04-12-978256-kg preserved. |
| integration/core/prompt-file-workflow.test.ts | (all 5 cases) | tests-new/integration/core/prompt-file-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| integration/core/resume.test.ts | (all 9 cases) | tests-new/integration/core/resume.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-002761-5n, r-2026-04-13-113237-33, r-2026-04-13-225142-nj, r-2026-04-13-335618-lz, r-2026-04-13-447523-5f, r-2026-04-13-557999-4v, r-2026-04-13-668475-2b, r-2026-04-13-780380-mr, r-2026-04-13-890856-k7 preserved. |
| integration/core/typed-vars-workflow.test.ts | (all 5 cases) | tests-new/integration/core/typed-vars-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100000-aa preserved. |
| integration/core/validators-workflow.test.ts | (all 3 cases) | tests-new/integration/core/validators-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-11-889356-fn preserved. |
| integration/core/view-resolution.test.ts | (all 3 cases) | tests-new/integration/core/view-resolution.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-23-419108-97 preserved. |
| integration/core/workflow.test.ts | (all 3 cases) | tests-new/integration/core/workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8 preserved. |
| integration/core/worktree-mocked.test.ts | (all 4 cases) | tests-new/integration/core/worktree-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-30-100000-w1, r-2026-04-30-100100-w2, r-2026-04-30-100200-w3 preserved. |
| integration/core/worktree-real.test.ts | (all 6 cases) | tests-new/integration/core/worktree-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-30-200000-w1 preserved. |

### Infra moves (D13) — not test rows

> These two shared helpers were **moved** to `tests-new/_support/` (U10.2), with a
> thin re-export shim left at the old `tests/helpers/` path so still-live non-core
> consumers keep resolving until they relocate in U11–U13 (R11). They are baseline
> `helper`/`asset` entries, **not** `test` entries — U14 reconcile accounts for
> them via this D13 `_support` move, not as relocated tests. Both keep their own
> `../../src/...` imports valid (two dirs deep before and after the move).

| Helper | From | To | Shim left at |
|---|---|---|---|
| fake-host.ts | tests/helpers/fake-host.ts | tests-new/_support/fake-host.ts | tests/helpers/fake-host.ts (`export * from '@orch/test/...'`) |
| temp-git-repo.ts | tests/helpers/temp-git-repo.ts | tests-new/_support/temp-git-repo.ts | tests/helpers/temp-git-repo.ts (`export * from '@orch/test/...'`) |

## Relocated — `runners/**` (parent U11)

> **Phase 11 / U11 is a RELOCATION, not a re-derivation (parent D1).** The
> `runners/**` tests are already plain class/integration tests with fakes at the
> `*Service` seam — today's `unit` concept *is* the parent's `unit` category.
> Each file below was COPIED to its `tests-new/{unit,integration}/runners` mirror
> with its body **byte-identical**; the only edits are cross-tree specifiers
> (`fake-host` and the one lifecycle ES import → `@orch/test/*`, parent D13) and,
> in four mocked integration files, the **runtime** raw-CLI-fixture path
> (`resolve(import.meta.dir, '../../../fixtures/{claude,codex}', …)`) repointed to
> the `_support` copies. Every relocated file imports the **same `src/` symbols**
> as its baseline original, machine-verified per file by `import-parity`
> (`bun run check:import-parity`, parent R10) — so the 1:1 case identity D15
> requires is preserved by construction, and one `port` row per file (the
> U7/U10 relocation precedent, PD5) is the accounting. No case was split, merged,
> demoted, or dropped; no `src/` file was touched. The 21 unit files needed **no**
> specifier rewrite at all (pure byte copies). The old copies are wrapped
> unconditional `describe.skip` with a `// MIGRATED →` marker and kept on disk
> forever (D2); the **five** capability-gated real/e2e-lite files
> (`claude-real`, `claude-e2e-lite`, `claude-structured-real`, `codex-real`,
> `cross-runner-parallel`) had their OLD copy flipped from `describe.skipIf(!canRun)`
> to unconditional `describe.skip` so U14's reconcile reads them as MIGRATED, while
> the NEW copies keep `skipIf` (legitimate capability gating, D8). *(Correction to
> the phase plan's PD4 inventory: the gated set is these five — `cross-runner-parallel`
> is gated; `scripted-fake/entry.real` is **not** gated, it runs an in-repo subprocess
> unconditionally.)* Embedded synthetic `RunId` constants travel verbatim with the
> byte-identical bodies. There are **no** `.test-d.ts` type-tests under `runners/**`.

> **Fixture handling (D13 `_support` move — infra, not test rows).** Three raw
> fixture sets the relocated tests need were **copied** into
> `tests-new/_support/fixtures/` (the PD2 copy fallback): `lifecycle/two-step-linear.ts`
> (its `src/` imports switched to `@orch/*` aliases, one dir deeper), `claude/`
> (6 files), and `codex/` (4 files). Originals are **left in place** — they still
> have live non-runner consumers (`hosts/plain/transcript-render-claude`, the
> behavioral-dsl `FIXTURES_DIR` directory consumer + the `.orch/orch.config.ts`
> CLI boot path) and the full `tests/fixtures/lifecycle/` directory move stays
> deferred (PD2). U14 reconcile accounts for these baseline `fixture` entries via
> this `_support` copy, **not** as relocated `test` rows.

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| unit/runners/claude/build-command.test.ts | (all 27 cases) | tests-new/unit/runners/claude/build-command.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/claude/claude-auto-stop.test.ts | (all 7 cases) | tests-new/unit/runners/claude/claude-auto-stop.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/claude/format-event.test.ts | (all 20 cases) | tests-new/unit/runners/claude/format-event.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/claude/parse-events.test.ts | (all 21 cases) | tests-new/unit/runners/claude/parse-events.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/build-command.test.ts | (all 36 cases) | tests-new/unit/runners/codex/build-command.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/capture-lock.test.ts | (all 5 cases) | tests-new/unit/runners/codex/capture-lock.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/capture-session-id.test.ts | (all 7 cases) | tests-new/unit/runners/codex/capture-session-id.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/capture-thread-id.test.ts | (all 18 cases) | tests-new/unit/runners/codex/capture-thread-id.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/codex-auto-stop.test.ts | (all 14 cases) | tests-new/unit/runners/codex/codex-auto-stop.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/format-event.test.ts | (all 14 cases) | tests-new/unit/runners/codex/format-event.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/codex/parse-events.test.ts | (all 18 cases) | tests-new/unit/runners/codex/parse-events.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/default-view.test.ts | (all 3 cases) | tests-new/unit/runners/default-view.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/define-runner.test.ts | (all 11 cases) | tests-new/unit/runners/define-runner.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/execute-interactive.test.ts | (all 2 cases) | tests-new/unit/runners/execute-interactive.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/execute.test.ts | (all 3 cases) | tests-new/unit/runners/execute.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/fake/fake-runner.test.ts | (all 9 cases) | tests-new/unit/runners/fake/fake-runner.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/runner-resume.test.ts | (all 10 cases) | tests-new/unit/runners/runner-resume.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/scripted-fake/addressing.test.ts | (all 7 cases) | tests-new/unit/runners/scripted-fake/addressing.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/scripted-fake/command-engine.test.ts | (all 15 cases) | tests-new/unit/runners/scripted-fake/command-engine.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/scripted-fake/script-loader.test.ts | (all 9 cases) | tests-new/unit/runners/scripted-fake/script-loader.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/runners/scripted-fake/scripted-fake-runner.test.ts | (all 11 cases) | tests-new/unit/runners/scripted-fake/scripted-fake-runner.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/claude/claude-e2e-lite.test.ts | (all 1 cases) | tests-new/integration/runners/claude/claude-e2e-lite.test.ts | port | Verbatim relocation — `fake-host` specifier → `@orch/test/*`; OLD copy's `describe.skipIf(!canRun)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). `src` import set unchanged. |
| integration/runners/claude/claude-mocked.test.ts | (all 3 cases) | tests-new/integration/runners/claude/claude-mocked.test.ts | port | Verbatim relocation — only the runtime raw-fixture path `../../../fixtures/claude` → `../../../_support/fixtures/claude` (fixtures copied to `_support`, PD2). `src` import set unchanged, parity guard green. |
| integration/runners/claude/claude-real.test.ts | (all 1 cases) | tests-new/integration/runners/claude/claude-real.test.ts | port | Verbatim relocation — body byte-identical; OLD copy's `describe.skipIf(!canRun)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). No `src` import change. |
| integration/runners/claude/claude-resume.test.ts | (all 1 cases) | tests-new/integration/runners/claude/claude-resume.test.ts | port | Verbatim relocation — `fake-host` specifier → `@orch/test/*`; runtime raw-fixture path `../../../fixtures/claude` → `../../../_support/fixtures/claude` (fixtures copied to `_support`, PD2). `src` import set unchanged, parity guard green. |
| integration/runners/claude/claude-structured-mocked.test.ts | (all 6 cases) | tests-new/integration/runners/claude/claude-structured-mocked.test.ts | port | Verbatim relocation — `fake-host` specifier → `@orch/test/*`; runtime raw-fixture path `../../../fixtures/claude` → `../../../_support/fixtures/claude` (fixtures copied to `_support`, PD2). `src` import set unchanged, parity guard green. |
| integration/runners/claude/claude-structured-real.test.ts | (all 1 cases) | tests-new/integration/runners/claude/claude-structured-real.test.ts | port | Verbatim relocation — `fake-host` specifier → `@orch/test/*`; OLD copy's `describe.skipIf(!canRun)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). `src` import set unchanged. |
| integration/runners/codex/codex-mocked.test.ts | (all 5 cases) | tests-new/integration/runners/codex/codex-mocked.test.ts | port | Verbatim relocation — only the runtime raw-fixture path `../../../fixtures/codex` → `../../../_support/fixtures/codex` (fixtures copied to `_support`, PD2). `src` import set unchanged, parity guard green. |
| integration/runners/codex/codex-real.test.ts | (all 1 cases) | tests-new/integration/runners/codex/codex-real.test.ts | port | Verbatim relocation — body byte-identical; OLD copy's `describe.skipIf(!canRun)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). No `src` import change. |
| integration/runners/cross-runner-parallel.test.ts | (all 1 cases) | tests-new/integration/runners/cross-runner-parallel.test.ts | port | Verbatim relocation — body byte-identical; OLD copy's `describe.skipIf(!canRun)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). No `src` import change. |
| integration/runners/run-runner.test.ts | (all 6 cases) | tests-new/integration/runners/run-runner.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/scripted-fake-ink.test.tsx | (all 4 cases) | tests-new/integration/runners/scripted-fake-ink.test.tsx | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/scripted-fake-interactive.test.ts | (all 11 cases) | tests-new/integration/runners/scripted-fake-interactive.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/scripted-fake-puppet-addressing.test.ts | (all 10 cases) | tests-new/integration/runners/scripted-fake-puppet-addressing.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/scripted-fake/entry.real.test.ts | (all 9 cases) | tests-new/integration/runners/scripted-fake/entry.real.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/runners/scripted-fake/two-step-linear.smoke.test.ts | (all 1 cases) | tests-new/integration/runners/scripted-fake/two-step-linear.smoke.test.ts | port | Verbatim relocation — `fake-host` and the `two-step-linear.ts` lifecycle-fixture ES import both → `@orch/test/*` (fixture copied to `_support`, PD2). `src` import set unchanged, parity guard green. |


## Relocated — `services(excl tmux)/state/validators/workflows/config/codegen/hosts(non-two-pane)` (parent U12)

> **Phase 12 / U12 is a RELOCATION, not a re-derivation (parent D1).** The seven
> non-two-pane module clusters here are already plain class/integration tests with
> fakes at the `*Service` seam — today's `unit`/`integration` concept *is* the
> parent's `unit`/`integration` category. Each file below was COPIED to its
> `tests-new/{unit,integration}` mirror with its body **byte-identical**; the only
> edits are cross-tree specifiers and one runtime fixture path:
> the **6** `make-step-entry` importers (5 unit `state` + `integration/state/state-store`)
> → `@orch/test/make-step-entry.ts`; the **1** `temp-git-repo` importer
> (`integration/validators/git-validators`) → `@orch/test/temp-git-repo.ts`; and the
> **1** `import.meta.dir` runtime fixture path in `integration/hosts/plain/transcript-render-claude`
> repointed to the existing `_support` fixture (PD4). Every relocated file imports the
> **same `src/` symbols** as its baseline original, machine-verified per file by
> `import-parity` (`bun run check:import-parity`, parent R10) — so the 1:1 case
> identity D15 requires is preserved by construction, and one `port` row per file
> (the U7/U10/U11 relocation precedent, PD6) is the accounting. No case was split,
> merged, demoted, or dropped; no `src/` file was touched. The old copies are
> wrapped unconditional `describe.skip` with a `// MIGRATED →` marker and kept on
> disk forever (D2); the one capability-gated file
> (`integration/services/prompt/ink-prompt-service-real`) had its OLD copy flipped
> from `describe.skipIf(!RUN_REAL)` to unconditional `describe.skip` so U14's
> reconcile reads it as MIGRATED, while the NEW copy keeps `skipIf` (legitimate
> capability gating, D8). There are **no** `.test-d.ts` type-tests in these
> clusters (deferred type-test relocation is U13).

> **Helper/asset handling (D13 `_support` move + co-located asset — infra, not test rows).**
> `tests/helpers/make-step-entry.ts` was **moved** to
> `tests-new/_support/make-step-entry.ts` with a thin re-export shim left at the old
> path (parent D13/R11). The shim is **kept** — cli/observability (U13) and still-live
> two-pane files still import the old path; it dies when U13 skips the last consumer.
> The co-located workflows asset `tests/integration/workflows/_harness.ts`
> (baseline-classified `asset`) was **copied** into
> `tests-new/integration/workflows/_harness.ts` (its `fake-host` specifier →
> `@orch/test/*`; `src` imports depth-preserved), mirroring U10's
> `_worktree-test-helpers.ts` co-located asset relocation; the original is left in
> place for the now-skipped old workflows tests. U14 reconcile accounts for these
> baseline `helper`/`asset` entries via the `_support` move / co-located copy,
> **not** as relocated `test` rows.

> **Exclusions (PD5/PD8 — left untouched and live, by design).** All **7**
> `tests/{unit,integration}/services/tmux/**` files are the **U13** `tmux-argv`-vs-`integration`
> classification job (parent §7 note) and are not relocated here. The **5**
> `tests/integration/hosts/two-pane-*.test.ts` files
> (`two-pane-mocked`, `two-pane-interactive`, `two-pane-interactive-session-lost`,
> `two-pane-failure-and-parallel`, `two-pane-sequential-runs`) are two-pane host
> integration tests (group B surface); their disposition belongs to group-B closeout /
> U14 (see the phase plan §9 open accounting gap). U12 leaves all 12 files byte-unchanged
> with **no** `// MIGRATED →` marker, still live.

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| integration/codegen/codegen-fixture.test.ts | (all 5 cases) | tests-new/integration/codegen/codegen-fixture.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/hosts/plain-host-command-line.test.ts | (all 3 cases) | tests-new/integration/hosts/plain-host-command-line.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/hosts/plain-mode.test.ts | (all 4 cases) | tests-new/integration/hosts/plain-mode.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/hosts/plain/transcript-render-claude.test.ts | (all 2 cases) | tests-new/integration/hosts/plain/transcript-render-claude.test.ts | port | Runtime fixture path `../../../fixtures/claude` → `../../../_support/fixtures/claude` (PD4; fixture already in `_support` from U11). Proven green from new location; `src` import set unchanged. |
| integration/hosts/tmux-host-command-line.test.ts | (all 4 cases) | tests-new/integration/hosts/tmux-host-command-line.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/services/fs/bun-fs-service.test.ts | (all 7 cases) | tests-new/integration/services/fs/bun-fs-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/services/process/bun-process-service.test.ts | (all 8 cases) | tests-new/integration/services/process/bun-process-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/services/prompt/ink-prompt-service-real.test.ts | (all 3 cases) | tests-new/integration/services/prompt/ink-prompt-service-real.test.ts | port | OLD copy's `describe.skipIf(!RUN_REAL)` flipped to unconditional `describe.skip` (R13); NEW copy keeps `skipIf` (capability gating, D8). No `src` import change. |
| integration/services/prompt/ink-prompt-service.test.ts | (all 7 cases) | tests-new/integration/services/prompt/ink-prompt-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/state/run-registry.test.ts | (all 1 cases) | tests-new/integration/state/run-registry.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/state/state-store.test.ts | (all 2 cases) | tests-new/integration/state/state-store.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| integration/validators/file-produced.test.ts | (all 3 cases) | tests-new/integration/validators/file-produced.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/validators/git-validators.test.ts | (all 5 cases) | tests-new/integration/validators/git-validators.test.ts | port | `temp-git-repo` specifier → `@orch/test/temp-git-repo.ts` (already in `_support`, U10). `src` import set unchanged, parity guard green. |
| integration/workflows/builtin-variants.test.ts | (all 7 cases) | tests-new/integration/workflows/builtin-variants.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/workflows/phased-build-decide.test.ts | (all 4 cases) | tests-new/integration/workflows/phased-build-decide.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/workflows/phased-build-input.test.ts | (all 6 cases) | tests-new/integration/workflows/phased-build-input.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| integration/workflows/phased-build-loop.test.ts | (all 5 cases) | tests-new/integration/workflows/phased-build-loop.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/codegen/discover-prompts.test.ts | (all 9 cases) | tests-new/unit/codegen/discover-prompts.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/codegen/emit-sidecar.test.ts | (all 9 cases) | tests-new/unit/codegen/emit-sidecar.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/codegen/extract-placeholders.test.ts | (all 12 cases) | tests-new/unit/codegen/extract-placeholders.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/codegen/run-codegen.test.ts | (all 7 cases) | tests-new/unit/codegen/run-codegen.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/config/load-config.test.ts | (all 19 cases) | tests-new/unit/config/load-config.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/await-foreground-shutdown.test.ts | (all 3 cases) | tests-new/unit/hosts/await-foreground-shutdown.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/failure-text.test.ts | (all 5 cases) | tests-new/unit/hosts/failure-text.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/host-registry.test.ts | (all 7 cases) | tests-new/unit/hosts/host-registry.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/pane-queue.test.ts | (all 4 cases) | tests-new/unit/hosts/pane-queue.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/parallel-rollup.test.ts | (all 7 cases) | tests-new/unit/hosts/parallel-rollup.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/plain-host-attach-foreground.test.ts | (all 1 cases) | tests-new/unit/hosts/plain-host-attach-foreground.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/plain-host.test.ts | (all 13 cases) | tests-new/unit/hosts/plain-host.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/plain/per-step-tee.test.ts | (all 6 cases) | tests-new/unit/hosts/plain/per-step-tee.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/plain/plain-host-subworkflow-divider.test.ts | (all 10 cases) | tests-new/unit/hosts/plain/plain-host-subworkflow-divider.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/plain/render-line-no-duplicate.test.ts | (all 5 cases) | tests-new/unit/hosts/plain/render-line-no-duplicate.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/terminal-reset.test.ts | (all 5 cases) | tests-new/unit/hosts/terminal-reset.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/tmux-host-attach-foreground.test.ts | (all 8 cases) | tests-new/unit/hosts/tmux-host-attach-foreground.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/hosts/tmux-host.test.ts | (all 24 cases) | tests-new/unit/hosts/tmux-host.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/clock/fake-clock.test.ts | (all 4 cases) | tests-new/unit/services/clock/fake-clock.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/clock/sleep.test.ts | (all 6 cases) | tests-new/unit/services/clock/sleep.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/fs/bun-fs-service.test.ts | (all 4 cases) | tests-new/unit/services/fs/bun-fs-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/fs/fake-fs-service-remove.test.ts | (all 4 cases) | tests-new/unit/services/fs/fake-fs-service-remove.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/fs/fake-fs-service.test.ts | (all 11 cases) | tests-new/unit/services/fs/fake-fs-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/fs/symlink.test.ts | (all 3 cases) | tests-new/unit/services/fs/symlink.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/git/bun-git-service.test.ts | (all 33 cases) | tests-new/unit/services/git/bun-git-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/git/fake-git-service.test.ts | (all 24 cases) | tests-new/unit/services/git/fake-git-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/process/fake-process-service.test.ts | (all 7 cases) | tests-new/unit/services/process/fake-process-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/process/foreground.test.ts | (all 5 cases) | tests-new/unit/services/process/foreground.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/process/line-framer.test.ts | (all 7 cases) | tests-new/unit/services/process/line-framer.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/process/merge-env.test.ts | (all 8 cases) | tests-new/unit/services/process/merge-env.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/process/raw-streams.test.ts | (all 13 cases) | tests-new/unit/services/process/raw-streams.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/prompt/confirm-service.test.ts | (all 14 cases) | tests-new/unit/services/prompt/confirm-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/prompt/fake-prompt-service.test.ts | (all 4 cases) | tests-new/unit/services/prompt/fake-prompt-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/prompt/ink-app.test.tsx | (all 8 cases) | tests-new/unit/services/prompt/ink-app.test.tsx | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/prompt/readline-prompt-service.test.ts | (all 5 cases) | tests-new/unit/services/prompt/readline-prompt-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/services/types.test.ts | (all 4 cases) | tests-new/unit/services/types.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/state/run-id.test.ts | (all 9 cases) | tests-new/unit/state/run-id.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/state/run-registry.test.ts | (all 8 cases) | tests-new/unit/state/run-registry.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/state/state-store-runner-name-and-capture-error.test.ts | (all 6 cases) | tests-new/unit/state/state-store-runner-name-and-capture-error.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| unit/state/state-store-session-id.test.ts | (all 4 cases) | tests-new/unit/state/state-store-session-id.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| unit/state/state-store-subpath.test.ts | (all 6 cases) | tests-new/unit/state/state-store-subpath.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| unit/state/state-store-v5.test.ts | (all 17 cases) | tests-new/unit/state/state-store-v5.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| unit/state/state-store.test.ts | (all 21 cases) | tests-new/unit/state/state-store.test.ts | port | `make-step-entry` specifier → `@orch/test/make-step-entry.ts` (helper moved to `_support`, PD2). `src` import set unchanged, parity guard green. |
| unit/validators/check.test.ts | (all 9 cases) | tests-new/unit/validators/check.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/validators/define-validator.test.ts | (all 8 cases) | tests-new/unit/validators/define-validator.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/validators/file-produced.test.ts | (all 9 cases) | tests-new/unit/validators/file-produced.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/validators/git-commit-created.test.ts | (all 4 cases) | tests-new/unit/validators/git-commit-created.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/validators/git-diff-created.test.ts | (all 4 cases) | tests-new/unit/validators/git-diff-created.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/validators/validation-error.test.ts | (all 7 cases) | tests-new/unit/validators/validation-error.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/workflows/parse-phases.test.ts | (all 16 cases) | tests-new/unit/workflows/parse-phases.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |
| unit/workflows/resolve-builtin.test.ts | (all 10 cases) | tests-new/unit/workflows/resolve-builtin.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite (`src` import set unchanged, parity guard green). |

## Relocated/Classified — cli · observability · e2e · type-tests · tmux · demotes (parent U13)

> **Phase 13 / U13 is the FINAL relocation phase (parent D1: relocation, not
> re-derivation).** It drains the last relocatable clusters of the frozen baseline
> (D12): `cli/**` (31), `observability/**` (13), the 4 remaining non-tier-4
> `e2e/**`, the 6 deferred `.test-d.ts` **type-tests**, the 3 behavioral-dsl
> **helper tests**, the **stragglers** (`barrel`, `examples/subworkflows-smoke`,
> `setup/reap-test-sockets` test), the explicitly-**classified** tmux
> adapter/harness set (PD3), and the relocatable **Category-A demotes** (PD5).
> Every file below was COPIED to its new home with its body **byte-identical**
> except cross-tree helper specifiers (rewritten to the `@orch/test/*` alias, PD2)
> and, for the two `real-tmux-harness` files, a depth correction of the `src`
> import prefix (5→3) since they move from `unit/hosts/two-pane/**` into
> `integration/real-tmux/**`. Every relocated file imports the **same `src/`
> symbols** as its baseline original, machine-verified per file by `import-parity`
> (`bun run check:import-parity`, parent R10) — 77 new pairs, all green. The old
> copies are wrapped unconditional `.skip` with a `// MIGRATED →` marker and kept
> on disk forever (D2); capability-gated old copies had `describe.skipIf(…)` /
> `it.skipIf(…)` flipped to unconditional `.skip` so U14 reconcile reads them as
> MIGRATED (R13), while the NEW copies keep `skipIf` (legitimate gating, D8).
>
> **tmux classification rule (PD3, §6).** A tmux test that boots **no real tmux**
> goes to `tests-new/tmux-argv/services/tmux/**` when it asserts adapter output
> (argv, escaping, encoded sequences, emitted config) or adapter input-validation
> (smart constructors for tmux ids) — this captured all 6 no-tmux files
> (`tmux-service`, `has-session-server`, `external-mouse-events`, `session-init`,
> `tmux-service-window`, and the integration `tmux-integration` which the file
> header itself calls an argv-construction test). A tmux test that **boots real
> tmux** (`skipIf`-gated) goes to `tests-new/integration/real-tmux/**` (harness /
> predictability substrate: the 6 `real-tmux/*`, the 2 `real-tmux-harness/*` infra
> tests, `cleanup-reaper`) or `tests-new/integration/services/tmux/**`
> (`tmux-real.integration`), gating preserved verbatim. **None dropped.** The
> `real-tmux-harness/{pane-handle,socket-allocation}` pair, despite its `two-pane/`
> origin path, tests the `_support/real-tmux/**` socket/pane infrastructure (U2
> substrate) — it asserts socket/handle mechanics, NOT rendering ("passes if the
> pane is empty" is **false** for it), so it is a relocation, **exempt from §9**.

| e2e/cli/orch-run.test.ts | (all 5 cases) | tests-new/e2e/cli/orch-run.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| e2e/resume-real-claude.test.ts | (all 1 cases) | tests-new/e2e/resume-real-claude.test.ts | port | Cross-tree specifier(s) → `@orch/test/fake-host` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| e2e/steps-tui-e2e.test.ts | (all 1 cases) | tests-new/e2e/steps-tui-e2e.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| e2e/workflows/builtin-phased-build.e2e.test.ts | (all 2 cases) | tests-new/e2e/workflows/builtin-phased-build.e2e.test.ts | port | Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/cli/commands/init-e2e.test.ts | (all 3 cases) | tests-new/integration/cli/commands/init-e2e.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/commands/init.test.ts | (all 17 cases) | tests-new/integration/cli/commands/init.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/commands/logs-old-and-new-runs.test.ts | (all 2 cases) | tests-new/integration/cli/commands/logs-old-and-new-runs.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| integration/cli/commands/new.test.ts | (all 12 cases) | tests-new/integration/cli/commands/new.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/commands/resume.test.ts | (all 8 cases) | tests-new/integration/cli/commands/resume.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/commands/runs.test.ts | (all 3 cases) | tests-new/integration/cli/commands/runs.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/commands/status.test.ts | (all 6 cases) | tests-new/integration/cli/commands/status.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| integration/cli/interactive-plain-error.test.ts | (all 1 cases) | tests-new/integration/cli/interactive-plain-error.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/interactivity-flag.test.ts | (all 6 cases) | tests-new/integration/cli/interactivity-flag.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/main-dispatch.test.ts | (all 5 cases) | tests-new/integration/cli/main-dispatch.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/run-builtin.test.ts | (all 5 cases) | tests-new/integration/cli/run-builtin.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/run-end-of-run-summary.test.ts | (all 2 cases) | tests-new/integration/cli/run-end-of-run-summary.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/run-resume-cycle.test.ts | (all 3 cases) | tests-new/integration/cli/run-resume-cycle.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| integration/cli/run-resume-registry-forwarding.test.ts | (all 1 cases) | tests-new/integration/cli/run-resume-registry-forwarding.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/single-pane-no-terminal-clear.test.ts | (all 2 cases) | tests-new/integration/cli/single-pane-no-terminal-clear.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/two-pane-auto-attach.test.ts | (all 5 cases) | tests-new/integration/cli/two-pane-auto-attach.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/two-pane-tty-guard.test.ts | (all 4 cases) | tests-new/integration/cli/two-pane-tty-guard.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/cli/unknown-flag.test.ts | (all 2 cases) | tests-new/integration/cli/unknown-flag.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/examples/subworkflows-smoke.test.ts | (all 5 cases) | tests-new/integration/examples/subworkflows-smoke.test.ts | port | Cross-tree specifier(s) → `@orch/test/fake-host` (PD2). `src` import set unchanged, parity green. |
| integration/observability/resume-per-step-folder.test.ts | (all 4 cases) | tests-new/integration/observability/resume-per-step-folder.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/observability/session-logger-baseline.integration.test.ts | (all 11 cases) | tests-new/integration/observability/session-logger-baseline.integration.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/observability/session-logger-debug.integration.test.ts | (all 6 cases) | tests-new/integration/observability/session-logger-debug.integration.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/observability/session-logger.e2e.test.ts | (all 9 cases) | tests-new/integration/observability/session-logger.e2e.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/observability/status-loop.test.ts | (all 9 cases) | tests-new/integration/observability/status-loop.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/observability/status-real.integration.test.ts | (all 1 cases) | tests-new/integration/observability/status-real.integration.test.ts | port | Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/agent-handle.test.ts | (all 4 cases) | tests-new/integration/real-tmux/agent-handle.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/predictable-fake-f1.test.ts | (all 2 cases) | tests-new/integration/real-tmux/predictable-fake-f1.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/predictable-fake-f2.test.ts | (all 2 cases) | tests-new/integration/real-tmux/predictable-fake-f2.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/predictable-fake-ink.test.ts | (all 1 cases) | tests-new/integration/real-tmux/predictable-fake-ink.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/predictable-fake-three-step.test.ts | (all 1 cases) | tests-new/integration/real-tmux/predictable-fake-three-step.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/real-tmux/teardown-leak-guard.test.ts | (all 3 cases) | tests-new/integration/real-tmux/teardown-leak-guard.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/services/tmux/tmux-integration.test.ts | (all 38 cases) | tests-new/tmux-argv/services/tmux/tmux-integration.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| integration/services/tmux/tmux-real.integration.test.ts | (all 26 cases) | tests-new/integration/services/tmux/tmux-real.integration.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| integration/tests-setup/cleanup-reaper.real.integration.test.ts | (all 6 cases) | tests-new/integration/real-tmux/cleanup-reaper.real.integration.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux`, `@orch/test/setup/reap-test-sockets` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| unit/barrel.test.ts | (all 5 cases) | tests-new/unit/barrel.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/argv.test.ts | (all 26 cases) | tests-new/unit/cli/argv.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/banner.test.ts | (all 4 cases) | tests-new/unit/cli/banner.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/commands/init-templates.test.ts | (all 7 cases) | tests-new/unit/cli/commands/init-templates.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/commands/scaffold.test.ts | (all 31 cases) | tests-new/unit/cli/commands/scaffold.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/detect-self.test.ts | (all 7 cases) | tests-new/unit/cli/detect-self.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/detect-tmux.test.ts | (all 9 cases) | tests-new/unit/cli/detect-tmux.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/execute-with-attach.test.ts | (all 8 cases) | tests-new/unit/cli/execute-with-attach.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/format.test.ts | (all 8 cases) | tests-new/unit/cli/format.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| unit/cli/logs-command.test.ts | (all 9 cases) | tests-new/unit/cli/logs-command.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| unit/cli/run-codegen-prepass.test.ts | (all 5 cases) | tests-new/unit/cli/run-codegen-prepass.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/tail-lines.test.ts | (all 3 cases) | tests-new/unit/cli/tail-lines.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/types-command-watch.test.ts | (all 3 cases) | tests-new/unit/cli/types-command-watch.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/cli/types-command.test.ts | (all 5 cases) | tests-new/unit/cli/types-command.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/core/ask-types.test-d.ts | (all 0 cases) | tests-new/unit/core/ask-types.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/core/prompt-file/promptfile-registry.test-d.ts | (all 0 cases) | tests-new/unit/core/prompt-file/promptfile-registry.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/core/prompt-file/template-vars.test-d.ts | (all 0 cases) | tests-new/unit/core/prompt-file/template-vars.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/core/run-workflow-typing.test-d.ts | (all 0 cases) | tests-new/unit/core/run-workflow-typing.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/core/step-runfn-typed-vars.test-d.ts | (all 0 cases) | tests-new/unit/core/step-runfn-typed-vars.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/core/workflow-typing.test-d.ts | (all 0 cases) | tests-new/unit/core/workflow-typing.test-d.ts | port | Type-test relocated into `tests-new/unit/core/**` where `tsc --noEmit` typechecks it (parent D11/D12). type-assertions specifier → `@orch/test/type-assertions.ts`. parity green. |
| unit/helpers/behavioral-dsl/invariants.test.ts | (all 20 cases) | tests-new/unit/support/behavioral-dsl/invariants.test.ts | port | Cross-tree specifier(s) → `@orch/test/behavioral-dsl/*` (PD2). `src` import set unchanged, parity green. |
| unit/helpers/behavioral-dsl/pane-matchers.test.ts | (all 22 cases) | tests-new/unit/support/behavioral-dsl/pane-matchers.test.ts | port | Cross-tree specifier(s) → `@orch/test/behavioral-dsl/*` (PD2). `src` import set unchanged, parity green. |
| unit/helpers/behavioral-dsl/snapshot.test.ts | (all 15 cases) | tests-new/unit/support/behavioral-dsl/snapshot.test.ts | port | Cross-tree specifier(s) → `@orch/test/behavioral-dsl/*` (PD2). `src` import set unchanged, parity green. |
| unit/hosts/two-pane/real-tmux-harness/pane-handle.test.ts | (all 11 cases) | tests-new/integration/real-tmux/pane-handle.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| unit/hosts/two-pane/real-tmux-harness/socket-allocation.test.ts | (all 18 cases) | tests-new/integration/real-tmux/socket-allocation.test.ts | port | **Classified `integration` real-tmux (PD3)** — boots real tmux, `skipIf` gating preserved verbatim. Cross-tree specifier(s) → `@orch/test/real-tmux` (PD2). `src` import set unchanged, parity green. NEW copy keeps `skipIf` (legitimate capability gating, D8); OLD copy flipped to unconditional `.skip` (R13). |
| unit/hosts/two-pane/steps-view/tui-overlay.test.ts | (all 11 cases) | tests-new/unit/hosts/two-pane/tui-overlay.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/file-session-logger.test.ts | (all 21 cases) | tests-new/unit/observability/file-session-logger.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/instrument-process-service.test.ts | (all 4 cases) | tests-new/unit/observability/instrument-process-service.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/null-session-logger.test.ts | (all 9 cases) | tests-new/unit/observability/null-session-logger.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/readme-template.test.ts | (all 5 cases) | tests-new/unit/observability/readme-template.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/redact.test.ts | (all 12 cases) | tests-new/unit/observability/redact.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/status-loop-subworkflow.test.ts | (all 4 cases) | tests-new/unit/observability/status-loop-subworkflow.test.ts | port | Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/observability/status-pane.test.ts | (all 26 cases) | tests-new/unit/observability/status-pane.test.ts | port | Cross-tree specifier(s) → `@orch/test/make-step-entry` (PD2). `src` import set unchanged, parity green. |
| unit/services/tmux/external-mouse-events.test.ts | (all 7 cases) | tests-new/tmux-argv/services/tmux/external-mouse-events.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Cross-tree specifier(s) → `@orch/test/behavioral-dsl/*` (PD2). `src` import set unchanged, parity green. |
| unit/services/tmux/has-session-server.test.ts | (all 12 cases) | tests-new/tmux-argv/services/tmux/has-session-server.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/services/tmux/session-init.test.ts | (all 12 cases) | tests-new/tmux-argv/services/tmux/session-init.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/services/tmux/tmux-service-window.test.ts | (all 4 cases) | tests-new/tmux-argv/services/tmux/tmux-service-window.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/services/tmux/tmux-service.test.ts | (all 43 cases) | tests-new/tmux-argv/services/tmux/tmux-service.test.ts | port | **Classified `tmux-argv` (PD3)** — argv/escaping/adapter or smart-constructor validation, boots NO real tmux (FakeProcessService / pure). Verbatim relocation — body byte-identical; no cross-tree imports to rewrite. `src` import set unchanged, parity green. |
| unit/setup/reap-test-sockets.test.ts | (all 12 cases) | tests-new/unit/support/reap-test-sockets.test.ts | port | Cross-tree specifier(s) → `@orch/test/setup/reap-test-sockets` (PD2). `src` import set unchanged, parity green. |

### Category-A demotes relocated (PD5)

> Three group-B-deferred (`→ U10–U13`) demotes had a clean verbatim case body and
> existing fake APIs, so they relocate here into a cheaper category. The other
> Category-A files routed to "U10–U13" are real-tmux/host **behavioral** tests
> whose disposition is recorded under §9 below.

| Old file (case) | New home | Disposition | Reason |
|---|---|---|---|
| unit/hosts/two-pane/steps-view/tui-overlay.test.ts (all 11 parse/serialize cases) | tests-new/unit/hosts/two-pane/tui-overlay.test.ts | demote→unit (PURE) | `parseTuiOverlayLine`/`serializeTuiOverlayLine` are pure model-state codec, not rendering (triage/D-P6). Verbatim; `src` depth 5→4 corrected; parity green. **Old file fully `.skip`.** |
| unit/hosts/two-pane/steps-view/adaptive-columns.test.ts (`COLUMN_THRESHOLDS` policy case) | tests-new/unit/hosts/two-pane/adaptive-columns-thresholds.test.ts | demote→unit (MIXED — case extract) | Pure threshold-constant policy assertion. The adaptive-column **render** case (`pickColumns` breakpoints) is group-B render and stays LIVE in the old file (D15 — no premature full skip). **Old file stays LIVE.** |
| unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts (real-`parallel()` persisted-records case) | tests-new/integration/hosts/two-pane/subworkflow-parallel-persisted-records.test.ts | demote→integration (MIXED — case extract) | Runs a real `parallel()` workflow via `parent.execute(deps)` with fakes and asserts persisted lifecycle records — execution/persistence ("passes if the pane is empty"). The three `projectStepsView` projection cases are group-B render and stay LIVE (D15). **Old file stays LIVE.** |

### Infra notes (D13 `_support` move — not test rows)

> **`tests/setup/reap-test-sockets.ts`** (a `setup` baseline entry, the reaper) was
> **moved** to `tests-new/_support/setup/reap-test-sockets.ts` (its one cross-dir
> import `../helpers/real-tmux/socket.ts` → `../real-tmux/socket.ts`), leaving a
> thin re-export shim at the old path so the still-live `cleanup-stale-tmux.ts`
> preload (which `import`s `./reap-test-sockets.ts`) keeps resolving. The relocated
> `reap-test-sockets.test.ts` imports it via `@orch/test/setup/reap-test-sockets.ts`.
> **`tests/setup/cleanup-stale-tmux.ts`** (the other `setup` entry, the bunfig
> preload) is **unchanged** and stays put — `bunfig.toml` still loads it; it reaches
> the reaper through the shim. Neither is a test relocation.

### Shim lifecycle (PD6) — all four shims KEPT after U13

> U13 rewrote its own `@orch/test/*` consumers. A `_support` shim is deleted only
> when U13 skips/relocates its **last** live old consumer. After U13, every shim
> still has live (un-`.skip`'d) old consumers, so **all are kept**:
> `make-step-entry` (live: `steps-view-model.test.ts`, `subworkflow-boundary-projection.test.ts`,
> and the still-LIVE `subworkflow-parallel-suppression.test.ts`);
> `fake-host` (live: `start-steps-view.test.ts` + the LIVE `subworkflow-parallel-suppression.test.ts`);
> `real-tmux` & `behavioral-dsl` (live: the entire still-LIVE lifecycle / two-pane
> real suites). Their deletion is handed to the §9 group-B closeout.

## Open accounting gap — group-B render/projection leftovers + non-relocatable behavioral demotes (**CLOSED by Phase 14**)

> **✅ CLOSED (Phase 14 group-B closeout, W3–W7).** Every file enumerated below is
> now wrapped `describe.skip` + a `// COVERED BY →` / `// MIGRATED →` / `// DROPPED →`
> marker, with every child case ledgered at case granularity in the
> *"Phase 14 — group-B closeout"* section near the end of this file. The frozen-
> baseline scanner `tests-new/_migration/reconcile.ts` (`bun run reconcile`) reports
> **zero** unaccounted baseline `test` cases. Disposition across the **224 cases /
> 57 files**: the bulk `skip-as-covered` (twin cited per case), **26 files
> demote-relocate** (added to `relocation-map.json`; import-parity green over all 268
> pairs), the remainder per-case `drop` (reason recorded), **0 re-derive** (coverage
> already existed — pure pruning). The text below is the *original gap record* (now
> historical).

> **Recorded per parent §3.7 / D1 / R3 / §9 — NOT U13 work; counted so U14 inherits
> an exact gap, not a surprise.** U13 relocates/classifies only what is a true
> relocation; it skips and re-derives **nothing** of the following, and leaves every
> file below **LIVE and unmarked**.

**(a) Category-B render/projection leftovers (need group-B re-derivation, not relocation).**
The still-LIVE `tests/**/two-pane/**` render files the parent §9 enumerates remain
LIVE: `steps-view/steps-view-colors.test.tsx`, `steps-view/steps-view-banner.test.tsx`,
the adaptive-column **render** cases (the threshold case demoted above), the LIVE
`steps-view/*.test.tsx` spans-files set, and the LIVE `integration/hosts/two-pane/**`
plumbing files. **Plus the 5 `integration/hosts/two-pane-*.test.ts`** files U12 flagged.

**(b) Non-relocatable Category-A behavioral demotes (real-tmux/host coordination — no faithful fake substrate).**
Four `→ U10–U13` demotes assert **end-to-end host behavior** (real tmux `wait-for`
stop-channels, real PTY pane lifecycle, or the real host's logger+store wiring) that
has **no faithful fake substrate** without building host-integration infrastructure
(a fake host with stop-channels / a wired session-logger run) — which is
re-derivation, **forbidden to a U13 relocation** by D1/R3. Their *component*
behaviors are already covered with fakes (auto-stop wiring by
`tests-new/unit/core/workflow-auto-stop.test.ts`; per-step disk artifacts by
`file-session-logger` / `transcript-sidecar` / `resume-per-step-folder`). Rather than
ship a green-but-unfaithful rewrite, U13 leaves these **LIVE** and counts them here:

| Old file (demoted case) | Why not relocated by U13 |
|---|---|
| integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts (4 stop-channel cases) | Tests the real-tmux host's `wait-for` stop-channel + PTY pane-exit race; `createFakeHost` has no stop-channel. Core auto-stop *wiring* already covered by `workflow-auto-stop.test.ts`. |
| integration/lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts (1 case) | Asserts session.json + events.ndjson land via the **real host's** logger+store wiring through a driven subprocess; fakes need that wiring assembled. Component-level disk persistence already covered. |
| integration/lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts (1 case) | Resume orchestration proven through the real driven host; faithful fake needs the same host wiring. |
| integration/lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts (1 case) | Per the U6 ledger note, the command-step host-fixture infrastructure (a `command(...)` step + pipe-pane capture) **does not exist** in `_support/real-tmux/`. |

> **Recommended resolution (parent §9).** A **group-B closeout** phase between U13 and
> U14, owned by a group-B-literate agent loading the two-pane scenario DSL (not the
> relocation recipe), dispositions each (a)/(b) entry as `skip-as-covered` /
> `re-derive` / `drop`. Until it lands, **U14 reconciliation cannot pass** — its
> frozen-baseline scan will (correctly) flag exactly the (a)+(b) set as unaccounted
> `test` entries. After U13, the only un-`.skip`'d, un-ledgered baseline `test`
> entries remaining are precisely this (a)+(b) set: the gap is now exact and counted.


---

## Phase 14 — group-B closeout (parent §9 / W3–W6) — CLOSED

The final disposition of every still-LIVE group-B baseline case (224 cases across
57 files). Each case is mapped to exactly one disposition (`skip-as-covered` /
`demote-relocate` / `re-derive` / `drop`, P14-D4) and its owning old file is wrapped
`describe.skip` + a `// COVERED BY →` / `// MIGRATED →` / `// DROPPED →` marker (D2,
kept on disk forever). The frozen-baseline scanner `tests-new/_migration/reconcile.ts`
reports **zero** unaccounted baseline `test` cases (assertions #1–#3). Disposition
counts: see the per-cluster tables below (C1 render/projection, C2 steps-view logic,
C3 flat two-pane + right-pane, C4 plumbing + real-tmux, C5 unit decision relocations,
C6 behavioral demotes + launcher smoke).


### Cluster C1

# C1 closeout ledger — steps-view render/projection `.test.tsx` (Category-B / W3)

> Cluster **C1** of the Phase-14 group-B closeout (parent §3 P14-D4/D5/D6, §5 W3).
> Every still-live case in the nine assigned `steps-view/*.test.tsx` files gets exactly
> one disposition. Render/projection cases re-derived in U5a/U5b/U6/U8 are
> `skip-as-covered` against the existing `tests-new/{model,screen,full-host}` twin
> (cited path verified on disk). A handful of cases not faithfully expressible through
> the scenario/driver DSL (steps=[] empty-state transient; the uppercase-F case-fold
> micro-detail; fake-tmux ERASE_SCROLLBACK absence assertions) are `drop` with a reason.
>
> Columns: `Old file | Old case | New scenario (path) | Disposition | Reason`.

### tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | renders the run header, every step name, and the keymap on a live run | tests-new/model/launch--header-and-step-list-render.test.ts (+ tests-new/screen/launch--header-and-step-list-render.test.ts) | skip-as-covered | Header breadcrumb + every step row + live-mode keymap footer are the launch render decision (model) proven to survive real tmux (screen). |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | renders the end-of-run footer when the run is no longer live | tests-new/model/end-of-run--summary-and-count.test.ts (+ tests-new/screen/end-of-run--summary-and-count-bytes.test.ts) | skip-as-covered | `run completed` + `q to quit` terminal footer is the end-of-run summary twin (decision + bytes). |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | snapshots a "no steps yet" empty live frame | — | drop | Pre-first-step `(no steps yet)` placeholder is a transient before any `step:start`; the scenario/driver DSL only launches WITH steps (`launch({ steps:[...] })`, model driver maps `spec.steps` to `StepRow[]`), so a faithful steps=[] frame is not expressible at the seam without extending the DSL (out of render-closeout scope). The header + live-footer halves are covered by launch--header-and-step-list-render. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | wraps the steps list in upper and lower hairline rules when steps exist | tests-new/screen/launch--header-and-step-list-render.test.ts | skip-as-covered | Hairline chrome around the populated step list is part of the launch render frame proven off real tmux (the structural box-rule survives tmux). |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | does not render hairlines around the empty state | — | drop | Same steps=[] empty-state transient as the placeholder snapshot — not expressible through the launch-with-steps DSL; a vacuous absence-of-rule assertion on a state the seam cannot produce. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | places the banner above the upper hairline when steps exist | tests-new/model/banner--info-and-error-paint.test.ts (+ tests-new/screen/banner--paint-bytes.test.ts) | skip-as-covered | Banner-above-grid placement is the banner paint decision (banner row emitted above the steps list) + its byte twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | keeps hairlines and drops the elapsed column on narrow terminals (<70 cols) | tests-new/screen/columns--elapsed-threshold.test.ts | skip-as-covered | The narrow-width adaptive-column drop is the elapsed-threshold screen twin (already lists this file in `oldTestRefs`); ledger U5a row 99 mapped it here. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | invokes onKey for arrow keys, return, f, q, and ? | — | drop | The `onKey` debug-telemetry tap (writes `tui-keys.ndjson`) is a diagnostic IPC seam, not a render or controller decision — passes with an empty/wrong pane. Not a two-pane render risk any twin owns; the navigation effects of these keys are covered by the selection/nav/help twins. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | emits the follow-live intent for uppercase F (case-insensitive) | — | drop | The follow-live DECISION is covered (model/selection--auto-tracks-live-and-browses via `followLive()`, footer hints). The case-FOLD micro-detail (caps-lock `F` must equal `f`) is not expressible through the semantic `followLive()` Pane Object method (it hardcodes lowercase `f`) and cannot be added without a raw-keystroke DSL primitive (out of scope). Flagged as a narrow uncovered keymap detail. |
| tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx | captures unknown keys as `other` with the raw input character | — | drop | `onKey` diagnostic-tap telemetry (the `other`/raw-input branch of `tui-keys.ndjson`), not a render/decision risk — passes with an empty pane. |

### tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders cursor and name in cyan on the selected row, with bold name | tests-new/model/selection--auto-tracks-live-and-browses.test.ts (+ tests-new/screen/selection--highlight-bytes.test.ts) | skip-as-covered | The cyan/bold selection accent on the committed row is the selection-highlight decision proven in bytes off real tmux (the `▌`/accent twin). |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | does not put cyan or bold on a row that is neither committed nor previewed | tests-new/model/selection--auto-tracks-live-and-browses.test.ts | skip-as-covered | The negative-accent control is the same selection decision (only the committed/preview rows carry the accent token; other rows render plain). |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders the preview cursor as a bold chevron with no cyan | tests-new/model/preview-cursor--browse-commit-snap.test.ts (+ tests-new/screen/preview-cursor--bytes.test.ts) | skip-as-covered | The `›` preview chevron (bold, no cyan) distinct from the committed accent is the preview-cursor decision + byte twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders a green check for completed steps | tests-new/model/glyph--state-and-color.test.ts (+ tests-new/screen/glyph--state-and-color-bytes.test.ts) | skip-as-covered | `done` → ✓ green via the co-located COLOR token (U5a ledger row 94). |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders a red cross for failed steps | tests-new/model/failure--failed-step-glyph-and-color.test.ts (+ tests-new/screen/failure--failed-step-glyph-and-color-bytes.test.ts) | skip-as-covered | The U5a-deferred red-cross case landed in U8 (ledger row 330) — ✗ red, decision + bytes, overlapGroup `failure-glyph`. |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders a yellow half-circle for running steps | tests-new/model/glyph--state-and-color.test.ts (+ tests-new/screen/glyph--state-and-color-bytes.test.ts) | skip-as-covered | `running` → ◐ yellow (U5a ledger row 95). |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | renders a dim middle dot for pending steps | tests-new/model/glyph--state-and-color.test.ts (+ tests-new/screen/glyph--state-and-color-bytes.test.ts) | skip-as-covered | `pending` → dim · is the remaining per-status glyph/colour variant of the same glyph-state-color twin (U5a row 96 deferred it here; the glyph twin asserts state→glyph+colour generically over the projected rows). |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | keeps glyph color independent of selection (committed failed row stays red, name turns cyan) | tests-new/model/failure--failed-step-glyph-and-color.test.ts (+ tests-new/model/selection--auto-tracks-live-and-browses.test.ts) | skip-as-covered | Glyph-colour-vs-selection-accent independence is the conjunction of the failure-glyph colour twin (glyph stays red) and the selection twin (name accent is cyan) — both co-located COLOR tokens are asserted independently. |
| tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | retains every structural element (names, glyphs, hairlines, cursor, footer) under stripAnsi | tests-new/screen/glyph--state-and-color-bytes.test.ts | skip-as-covered | The NO_COLOR/stripAnsi structural-integrity snapshot (names+glyphs+hairlines+cursor+footer survive colour-stripping) is proven structurally by the real-tmux glyph byte twin, which asserts the stripped structure on screen; the snapshot is a stable-capture restatement (cf. U5b row 127 drop rationale, but here a screen twin owns the structure). |

### tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | renders ▶ live · ⏎ view step · q quit · ? help in live mode (no `f live` token) | tests-new/model/footer--view-mode-hints.test.ts (+ tests-new/screen/footer--view-mode-hints-bytes.test.ts) | skip-as-covered | Live-mode footer hints + `assertFollowLiveHintHidden` (U5b ledger row 138). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | renders ⏸ viewing <stepName> · f live · … in replay mode | tests-new/model/footer--view-mode-hints.test.ts (+ tests-new/screen/footer--view-mode-hints-bytes.test.ts) | skip-as-covered | Replay-mode viewing+follow hints after a real selection change (U5b ledger row 139). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | truncates a long stepName to 30 chars with ellipsis in the footer | tests-new/model/footer--view-mode-hints.test.ts | skip-as-covered | The footer viewing-hint truncation is part of the replay-mode footer-hint render (`assertViewingHintVisible(<step>)`); the 30-char ellipsis is co-located footer chrome on the same view-mode-footer twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | renders an info banner above the steps grid | tests-new/model/banner--info-and-error-paint.test.ts (+ tests-new/screen/banner--paint-bytes.test.ts) | skip-as-covered | Info banner paint above the grid (U5b ledger row 140). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | renders an error banner with an Esc-dismiss hint | tests-new/model/banner--info-and-error-paint.test.ts (+ tests-new/screen/banner--paint-bytes.test.ts) | skip-as-covered | The `! … · Esc dismiss` error envelope (U5b ledger row 141). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | Esc with help open closes help only — does not dispatch dismiss-banner | tests-new/model/help-overlay--opens-and-closes.test.ts | skip-as-covered | Esc-precedence: with help open, Esc closes the overlay (the help-overlay open/close decision) and the banner is untouched — the U5b-deferred Esc/help keymap mechanics closed in U6. |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | Esc with help closed and an error banner dispatches dismiss-banner | tests-new/model/banner--info-and-error-paint.test.ts | skip-as-covered | Esc on an error banner dismisses it — the dismiss-banner decision over the persisting error banner (also pinned by key-intent → banner twin). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | Esc with help closed and no banner is a no-op | tests-new/model/help-overlay--opens-and-closes.test.ts | skip-as-covered | Esc with nothing to close is a no-op — the negative branch of the help-overlay/Esc precedence decision. |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | Esc on an info banner is NOT manually dismissable (auto-clears instead) | tests-new/model/banner--info-clears-error-persists.test.ts | skip-as-covered | Info banners auto-clear on TTL rather than respond to manual Esc — the info-clears/error-persists TTL decision twin (D-P2 virtual clock). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | dispatches dismiss-banner for an info banner after ttlMs elapses | tests-new/model/banner--info-clears-error-persists.test.ts | skip-as-covered | Info auto-clears on the virtual clock (U5b ledger row 142). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | does NOT auto-dismiss an error banner regardless of ttlMs | tests-new/model/banner--info-clears-error-persists.test.ts | skip-as-covered | Error persists past `advanceTime` (U5b ledger row 143). |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | restarts the auto-dismiss timer when seq bumps even with identical text | tests-new/model/banner--info-clears-error-persists.test.ts | skip-as-covered | The seq-bump timer-restart is the re-keying mechanism BEHIND the info-auto-clear decision: the TTL twin proves info clears on each fresh emit's virtual-clock deadline; the per-`seq` `scheduleDismiss` restart is the implementation detail that makes that decision hold, and is exercised by the auto-clear-after-TTL assertion. |
| tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | lists f, Esc, and the view-mode indicator | tests-new/model/help-overlay--opens-and-closes.test.ts (+ tests-new/screen/help-overlay--paint-bytes.test.ts) | skip-as-covered | The HelpOverlay content (the `f`/`Esc`/`▶ live` view-mode indicator listing) is the help-overlay paint decision + its byte twin. |

### tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | starts at live tail with no scrolled indicator in the footer | tests-new/model/scroll--viewport-follows-window.test.ts (+ tests-new/screen/scroll--window-bytes.test.ts) | skip-as-covered | At the live tail the newest window shows and no scrolled indicator appears — the initial state of the viewport-window decision (`assertStepOffscreen` on the oldest while at tail) + byte twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | k scrolls up and surfaces the scrolled indicator in the footer | tests-new/model/scroll--viewport-follows-window.test.ts (+ tests-new/screen/scroll--window-bytes.test.ts) | skip-as-covered | Scrolling up brings an off-window step into view (`scrollToOldest`); the `↑ scrolled` / `End live` footer chrome is co-located with the scroll-window twins which drive the same scroll-off-tail mechanics. |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | End resets the scroll offset, emits follow-live, and clears the scrolled indicator | tests-new/model/scroll--viewport-follows-window.test.ts (+ tests-new/screen/scroll--window-bytes.test.ts) | skip-as-covered | Jump-to-live (`scrollToLive`) returns the window to the tail and clears the scrolled indicator — the return-to-tail half of the scroll-window decision + bytes. |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | PageUp moves the offset further than k (one row vs many) | tests-new/model/scroll--viewport-follows-window.test.ts | skip-as-covered | PageUp-vs-k offset magnitude is a within-window scroll-offset decision; the viewport-window twin owns which rows fall in the window after scrolling (the user-visible effect — the bigger jump exposes an earlier step). |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | Home clamps to the top of the buffer (visible window starts at step-000) | tests-new/model/scroll--viewport-follows-window.test.ts (+ tests-new/screen/scroll--window-bytes.test.ts) | skip-as-covered | Jump-to-top clamps the window to the oldest step (`scrollToOldest` → `assertStepVisible` on the first step) — the scroll-to-oldest half of the scroll-window twins. |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | scroll offset survives a state-prop change so a new step event does not jerk the viewport (R11/AE3) | tests-new/model/scroll--viewport-follows-window.test.ts | skip-as-covered | Offset-stable-across-step-arrival is the viewport-follows-window decision: the window is anchored by the scroll offset, not jerked to the tail on each new step — the very invariant the model member projects. |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | few-step case (steps.length <= visibleCount) does not surface the scrolled indicator after k | tests-new/model/scroll--viewport-follows-window.test.ts | skip-as-covered | When all steps fit the viewport there is no off-window region to scroll into, so no indicator — the negative/short-buffer branch of the same viewport-window decision (nothing is offscreen). |
| tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | ArrowUp/ArrowDown remain pure selection movement and do not surface the scrolled indicator | tests-new/model/nav--up-down-keeps-live-running.test.ts | skip-as-covered | ↑/↓ move the preview cursor (selection), decoupled from scroll/live — the selection-decoupled-from-live decision; browsing does not scroll the viewport. |

### tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx | highlights the single live step at startup so the left pane matches the right pane | tests-new/model/selection--auto-tracks-live-and-browses.test.ts (+ tests-new/screen/selection--highlight-bytes.test.ts) | skip-as-covered | Committed highlight auto-tracks the live step at launch (U5a ledger row 80) — the left pane matching the right-pane source is exactly the committed-highlight-tracks-live decision + byte twin. |
| tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx | keeps the highlight on the step the right pane shows when there are multiple steps at startup | tests-new/model/selection--auto-tracks-live-and-browses.test.ts | skip-as-covered | Multi-step startup: the committed highlight lands on the live (right-pane) step — the same auto-track decision with >1 step. |
| tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx | moves the highlight to the next step when the right pane auto-advances without a keypress | tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | skip-as-covered | When the right pane auto-advances to the next live step, the left committed highlight follows it (`assertStepSelected` after auto-advance) — the full-host auto-advance plumbing twin. |
| tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx | shows exactly one highlighted row and it equals the right-pane step | tests-new/model/selection--auto-tracks-live-and-browses.test.ts (+ tests-new/screen/selection--highlight-bytes.test.ts) | skip-as-covered | Exactly-one-committed-highlight-equals-live is the single-committed-row invariant of the auto-track decision; the byte twin proves one `▌` highlight renders. |

### tests/unit/hosts/two-pane/steps-view/header-rerender.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/header-rerender.test.tsx | renders the breadcrumb header exactly once after state changes + a pane resize at a narrow width | tests-new/screen/launch--header-and-step-list-render.test.ts | skip-as-covered | The no-duplicate-breadcrumb-after-resize regression is a real-tmux render-survival risk: the launch header byte twin asserts the breadcrumb renders correctly on real tmux (a duplicated header would be visible in the captured bytes), which is the faithful re-derivation of the VirtualTerminal resize-flicker check at the screen fidelity that owns byte-survival. |

### tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx | does not emit a full-screen clearTerminal when a scroll-up keypress is pressed at a narrow pane width | tests-new/screen/scroll--window-bytes.test.ts | skip-as-covered | The ERASE_SCROLLBACK-absence flicker check is a fake-tmux byte-stream assertion (ink-testing-library `stdout.raw`); the genuine "scroll renders correctly without blanking" risk is owned by the real-tmux scroll-window byte twin, where a full-pane clear would manifest as the window failing to render. The clearTerminal-absence assertion itself is a fake-tmux implementation probe (cf. U5b row 127 / triage: passes regardless of pane content). |
| tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx | stays flicker-free across repeated scroll keypresses | tests-new/screen/scroll--window-bytes.test.ts | skip-as-covered | Repeated-scroll flicker-freedom is the same fake-tmux ERASE_SCROLLBACK-absence probe; the real-tmux scroll-window byte twin proves repeated scroll keystrokes keep rendering the window faithfully. |
| tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx | does not blank the pane when a banner appears or disappears mid-run | tests-new/screen/banner--paint-bytes.test.ts | skip-as-covered | Banner appear/disappear without blanking: the banner paint byte twin proves the banner row paints (and the steps survive) on real tmux; the no-clearTerminal probe is the fake-tmux implementation detail behind it. |
| tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx | keeps the scrolled / End-live indicator visible at a narrow width | tests-new/screen/scroll--window-bytes.test.ts | skip-as-covered | The narrow-width scrolled/`End live` indicator visibility is the scroll-window render at a small pane proven off real tmux (the scroll twins resize to a short pane and assert the window + footer survive). |

### tests/unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx | renders the placeholder row, the run header, and the live footer when steps is [] | — | drop | Pre-first-step `(no steps yet)` placeholder transient: the scenario/driver DSL launches WITH steps (`launch({ steps:[...] })`; the model driver maps `spec.steps`→`StepRow[]`, so steps=[] is not a producible state), so a faithful empty-frame scenario cannot be authored at the seam without extending the DSL (out of render-closeout scope). The header + live-footer halves are covered by launch--header-and-step-list-render. |
| tests/unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx | Enter fires no intent when there is no selectable step | — | drop | The empty-steps Enter-no-op guard is the same steps=[] transient the DSL cannot produce; the positive Enter-commits-a-step decision is covered by key-intent → tests-new/full-host/fake-agent/nav--enter-swaps-right-pane-to-transcript.test.ts and model/selection. |

### tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | ⏎ on the selected step fires { type: enter, stepName } | tests-new/full-host/fake-agent/nav--enter-swaps-right-pane-to-transcript.test.ts (+ tests-new/model/selection--auto-tracks-live-and-browses.test.ts) | skip-as-covered | Enter on the committed step emits the enter/select intent — the full-host twin proves Enter swaps the right pane to that step's transcript (the user-visible effect of the `enter` intent); the model selection twin owns `selectStep`. |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | f fires { type: follow-live } exactly once | tests-new/model/selection--auto-tracks-live-and-browses.test.ts (+ tests-new/model/footer--view-mode-hints.test.ts) | skip-as-covered | `f` → follow-live is the snap-back-to-live decision (`followLive()` in the selection twin); the footer twin pins the `f live` affordance. |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | q fires { type: quit } | tests-new/model/footer--view-mode-hints.test.ts (+ tests-new/screen/footer--view-mode-hints-bytes.test.ts) | skip-as-covered | `q` → quit: the quit affordance is the `q quit` footer hint the user acts on (the published keymap copy that the footer-hints twin pins); the quit intent itself is a trivial keymap edge dropped at the projection seam, owned by the footer copy. |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | Esc on an error banner fires { type: dismiss-banner } | tests-new/model/banner--info-and-error-paint.test.ts | skip-as-covered | Esc on an error banner dismisses it — the dismiss decision over the error banner the paint twin renders (Esc-dismiss hint + the dismiss-banner effect). |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | Esc on no banner fires no intent | tests-new/model/help-overlay--opens-and-closes.test.ts | skip-as-covered | Esc with no banner / no help is a no-op — the negative branch of the Esc/help-overlay precedence decision. |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | ↑/↓ does not fire any intent — selection is local state | tests-new/model/nav--up-down-keeps-live-running.test.ts | skip-as-covered | ↑/↓ move only the local preview cursor and fire no intent (selection is local) — the selection-decoupled-from-live decision. |
| tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | ? opens help and does not fire any intent | tests-new/model/help-overlay--opens-and-closes.test.ts (+ tests-new/screen/help-overlay--paint-bytes.test.ts) | skip-as-covered | `?` opens the help overlay and fires no navigation intent — the help-overlay open decision + byte twin. |


### Cluster C2

# C2 closeout — steps-view model/logic `.ts` files (parent U14, group-B closeout)

> Cluster C2: pure decision/coordination logic for the two-pane steps view
> (projection, lifecycle-event fold, tail/file-watch coordination, intent
> parsing). Triage rule applied per case — almost all "pass if the pane is
> empty" → decision/coordination tests, NOT pane-byte tests. Defaults to
> `demote-relocate` where no `tests-new/` twin exists; `skip-as-covered` where a
> twin already proves the case. Two MIXED files (`adaptive-columns`,
> `subworkflow-parallel-suppression`) had a case already ledgered/relocated in
> U13/U7c — only the remaining cases are dispositioned here.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|

### tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | returns a live state with no steps when neither persisted state nor overlay exist | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure `projectStepsView` projection (passes if the pane is empty); no model twin. Verbatim body, `make-step-entry` helper → `@orch/test/`, `src` depth unchanged. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | surfaces a running step that exists only in the overlay (not yet persisted) | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure projection of overlay-only rows; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | renders a completed agent step persisted in state.json with no live overlay entry | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure projection of persisted state; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | marks a step as failed when the live overlay says so | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure overlay-wins-over-state projection decision; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | routes prefixed names to the correct kind (commit / worktree / ask / command) and bare names to agent | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure name→kind routing decision; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | produces a completed end-of-run summary when every step succeeded | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure summary computation (totals/duration); no twin. Distinct from the U5b `end-of-run--summary` render twins — this is the projector's numeric summary fields. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | flips a completed run to failed status when at least one step has live status failed | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure status-derivation decision; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | reports a crashed run with non-optional summary | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure crashed-summary projection; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | defaults view to {mode:"live"} when omitted, with no banner | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure view-default decision; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | propagates a replay view-mode through to the projected state | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure view passthrough; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | propagates a banner verbatim onto the projected state | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure banner passthrough; no twin. |
| tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | preserves view + banner on terminal-status runs (completed/failed/crashed) | tests-new/unit/hosts/two-pane/steps-view/steps-view-model.test.ts | demote-relocate | Pure view+banner preservation across terminal status; no twin. |

### tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | records a step:start as running with startedAt and the supplied mode | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure per-line fold over the overlay Map (passes if the pane is empty); no twin. Verbatim body; only `src/hosts` import (depth unchanged). |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | records a step:start with mode=interactive as status interactive | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold (interactive status derivation); no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | preserves subPath and insideParallel metadata for live-only projected rows | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure metadata-preservation fold; no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | flips to completed on step:complete and preserves the prior mode + startedAt | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold transition; no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | flips to failed on step:failed and preserves the prior mode + startedAt | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold transition; no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | uses subPath metadata on terminal events even when no start event was seen | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold (out-of-order terminal event); no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | marks step:cached without overwriting previously-set timing fields | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold (cached status); no twin. |
| tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | ignores events with an unknown type or missing stepName so the projector cannot wedge on bad lifecycle lines | tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | demote-relocate | Pure fold (malformed-line rejection); no twin. |

### tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts | hides elapsed below width 70 and exposes it from 70 upward across the canonical breakpoints | tests-new/screen/columns--elapsed-threshold.test.ts | skip-as-covered | Adaptive-column hide/show is a render byte risk proven off real tmux by the U5a screen twin (ledger line 97, `port→screen`). The `pickColumns` boolean table is fully exercised at the byte level there. |
| tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts | exposes the documented threshold constants so future phases can flip cost/tokens on without forking the policy | tests-new/unit/hosts/two-pane/adaptive-columns-thresholds.test.ts | skip-as-covered | Pure `COLUMN_THRESHOLDS` policy case — already demote-relocated in U13 (ledger line 98/839). Disposition recorded there; cited here for completeness. |

### tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts | suppresses sub boundary rows for sub-of-parallel branches (AE9) | tests-new/model/projector/subworkflow-parallel-suppression.test.ts | skip-as-covered | Pure `projectStepsView` suppression invariant — already ported in U7c (ledger line 257). Twin asserts the identical case verbatim. |
| tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts | suppresses transitively for sub-of-sub-inside-parallel (AE13) | tests-new/model/projector/subworkflow-parallel-suppression.test.ts | skip-as-covered | Pure transitive-suppression invariant — already ported in U7c. Twin asserts it verbatim. |
| tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts | does NOT suppress sequential subs whose steps run outside any parallel | tests-new/model/projector/subworkflow-parallel-suppression.test.ts | skip-as-covered | Pure negative-control suppression invariant — already ported in U7c. Twin asserts it verbatim. |
| tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts | keeps insideParallel on lifecycle records for suppressed homogeneous sub boundaries | tests-new/integration/hosts/two-pane/subworkflow-parallel-persisted-records.test.ts | skip-as-covered | Real-`parallel()` persisted-records case — already demote-relocated in U13 (ledger line 258/840). Twin runs `parent.execute(deps)` and asserts the identical persisted lifecycle records. |

### tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | records intentsStartOffset = 0 for a fresh state dir and spawns the runner script onto the left pane | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Parent-side factory coordination over FakeHost/FakeTmux/real PaneQueue (records argv + offset — passes if the pane is empty); no twin. `fake-host` helper → `@orch/test/`, `src` depth unchanged. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | records intentsStartOffset to the size of the existing intents file so stale lines are not replayed | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Stale-line offset coordination; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | dispatches an intent appended after start through onIntent | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Intent-dispatch coordination over a real tailer + tempdir; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | logs a `tui-intent` lifecycle entry for each parsed intent received from the child | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Lifecycle-log coordination; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | logs a `tui-intent-parse-error` lifecycle entry when the intents file contains garbage | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Parse-error log coordination; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | writes the canonical "TUI unavailable" message via PaneQueue and logs tui-crashed on unexpected child exit | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Crash-path PaneQueue/log coordination — asserts the queued sendKeys carries the canonical message (a coordination outcome via FakeTmux, not a real-tmux byte read); no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | parses {type: "dismiss-banner"} successfully | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Pure `StepsIntentSchema` zod parse; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | rejects unknown intent types | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Pure intent-schema rejection; no twin. |
| tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | still parses the legacy intents | tests-new/unit/hosts/two-pane/steps-view/start-steps-view.test.ts | demote-relocate | Pure legacy-intent parse; no twin. |

### tests/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | emits one onLine call per newline-terminated record found in the file | tests-new/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | demote-relocate | Pure line-framing/file-watch coordination against real fs (passes if the pane is empty); no twin. Verbatim body; only `src` imports (depth unchanged). |
| tests/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | buffers a trailing partial line until the producer writes the newline | tests-new/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | demote-relocate | Pure partial-line buffering coordination; no twin. |
| tests/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | skips pre-existing content under startOffset >= size and surfaces only post-start appends | tests-new/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | demote-relocate | Pure startOffset coordination; no twin. |

### tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | fires onChange exactly once when start() is called against an existing file (leading-edge) | tests-new/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | demote-relocate | Pure leading-edge file-watch coordination against real fs (passes if the pane is empty); no twin. Verbatim body; only `src` imports (depth unchanged). |
| tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | re-fires onChange after a subsequent writeFile (poll fallback at 50ms catches it) | tests-new/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | demote-relocate | Pure poll-fallback coordination; no twin. |
| tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | is idempotent on stop() — calling twice does not throw | tests-new/unit/hosts/two-pane/steps-view/tail-state-json.test.ts | demote-relocate | Pure stop()-idempotence coordination; no twin. |


### Cluster C3

# C3 closeout ledger — flat two-pane-* integration + right-pane plumbing

> Cluster C3 (Phase 14 / W5). Disposition of every still-live group-B case in
> the flat `integration/hosts/two-pane-*.test.ts` host-coordination set and the
> nested `integration/hosts/two-pane/**` right-pane plumbing set. One row per
> baseline case (D15). Dispositions per P14-D4: `skip-as-covered` (twin cited and
> verified to exist), `demote-relocate` (plain pane-agnostic coordination test
> relocated verbatim), `drop` (vacuous, reason given).

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|

### tests/integration/hosts/two-pane-mocked.test.ts
| tests/integration/hosts/two-pane-mocked.test.ts | streams readable transcript bytes through the per-step tee (U5: no right-pane sendKeys for transcripts) | tests-new/integration/hosts/two-pane/two-pane-mocked.test.ts | demote-relocate | Pane-agnostic host-coordination integration test — asserts NO right-pane sendKeys + the per-step tee captures readable bytes (passes if the pane is empty). No full-host/model twin; relocated verbatim (imports rewritten only). |
| tests/integration/hosts/two-pane-mocked.test.ts | left pane is no longer painted by startStatusLoop (steps-view daemon owns it) | tests-new/integration/hosts/two-pane/two-pane-mocked.test.ts | demote-relocate | Recorded-call wiring invariant (only `clear && exec cat` reaches %0); pane-agnostic, no twin. Relocated verbatim. |
| tests/integration/hosts/two-pane-mocked.test.ts | persists rendered transcript bytes to agents/<step>/formatted_output.{ansi,txt} | tests-new/integration/hosts/two-pane/two-pane-mocked.test.ts | demote-relocate | File-persistence + stripAnsi(ansi)==txt assertion; pane-agnostic, no twin. Relocated verbatim. |
| tests/integration/hosts/two-pane-mocked.test.ts | captures workflow-body console.log between steps instead of leaking it to tmux | tests-new/integration/hosts/two-pane/two-pane-mocked.test.ts | demote-relocate | Stdio-capture coordination (console.log → orch-stdio.log, never tmux sendKeys); pane-agnostic, no twin. Relocated verbatim. |

### tests/integration/hosts/two-pane-interactive.test.ts
| tests/integration/hosts/two-pane-interactive.test.ts | creates a per-source PTY session with runner argv, swaps it visible, waits pane-exit, then kills the session (U4) | tests-new/unit/hosts/tmux-host.test.ts ('creates a per-source tmux session with the runner argv + env + cwd, swaps it visible, and kills the session on exit (U4)') | skip-as-covered | Same per-source createSession (`orch-src-interactive-review`) + no-right-pane-respawn + swapPane + killSession + pane-exit waitFor lifecycle, driven directly through `host.runInteractive` at the port (a superset). |

### tests/integration/hosts/two-pane-sequential-runs.test.ts
| tests/integration/hosts/two-pane-sequential-runs.test.ts | two consecutive runs in the same process both finish cleanly | tests-new/integration/hosts/two-pane/two-pane-sequential-runs.test.ts | demote-relocate | Real-tmux "second run blinks and exits" host-coordination regression; asserts run completion only (pane-agnostic). No twin. Relocated verbatim, real-tmux `skipIf` gating preserved. |
| tests/integration/hosts/two-pane-sequential-runs.test.ts | two consecutive runs against the same workspace filesystem both finish cleanly | tests-new/integration/hosts/two-pane/two-pane-sequential-runs.test.ts | demote-relocate | Workspace-leak host-coordination regression; pane-agnostic completion assertion. No twin. Relocated verbatim. |
| tests/integration/hosts/two-pane-sequential-runs.test.ts | two consecutive CLI subprocess invocations both produce a state directory | tests-new/integration/hosts/two-pane/two-pane-sequential-runs.test.ts | demote-relocate | Cross-process socket-layer regression (exit 0 + 2 state dirs); pane-agnostic. No twin. Relocated verbatim. |

### tests/integration/hosts/two-pane-failure-and-parallel.test.ts
| tests/integration/hosts/two-pane-failure-and-parallel.test.ts | renders the Story 1.5 failure frame on the right pane when an autonomous step fails | tests-new/unit/hosts/tmux-host.test.ts ('TmuxHost.onLifecycleEvent — step:failed' → 'does not sendKeys the failure frame to the right pane — it is appended to the per-step tee (U5)') | skip-as-covered | The live assertion here is the U5 invariant: zero right-pane sendKeys on failure (the failure-frame behavior is explicitly deferred to the tmux-host unit by the file's own comment, this fixture having no controller). The no-sendKeys-on-failure invariant is the cited twin. |
| tests/integration/hosts/two-pane-failure-and-parallel.test.ts | does not fan rollup bytes onto the right pane (U7 invariant) — no logger, no controller | tests-new/unit/hosts/tmux-host.test.ts ('TmuxHost.onLifecycleEvent — step:parallel-branch-update' → 'does not fan rollup bytes onto the right pane (U7 invariant — rollup lives in the _rollup tee)') | skip-as-covered | Identical U7 no-fan-out invariant, asserted at the host port. The happy-path-with-controller rollup pane-map path is covered separately by the right-pane-controller sources/lifecycle twins. |

### tests/integration/hosts/two-pane-interactive-session-lost.test.ts
| tests/integration/hosts/two-pane-interactive-session-lost.test.ts | translates the dead-socket TmuxCommandError into a HostUnavailableError instead of letting it escape un-wrapped | tests-new/integration/hosts/two-pane/two-pane-interactive-session-lost.test.ts | demote-relocate | Host-level error-mapping decision (`host.runInteractive` → `HostUnavailableError`); pane-agnostic. The model/controller right-pane-controller-session-lost twin covers the CONTROLLER surfacing the dead-socket error, NOT the host-port translation — so no twin covers this; relocated verbatim. |

### tests/integration/hosts/two-pane/right-pane-live-output.test.ts
| tests/integration/hosts/two-pane/right-pane-live-output.test.ts | writes runner bytes to the per-step tee instead of the visible right pane | tests-new/unit/hosts/tmux-host.test.ts ('TmuxHost.onRunnerEvent' → 'does not sendKeys to the right pane — runner bytes flow through the per-step tee (U5)') | skip-as-covered | Same U5 no-right-pane-sendKeys + tee-captures-bytes invariant, asserted at the host port. |
| tests/integration/hosts/two-pane/right-pane-live-output.test.ts | does not respawn the right pane during the autonomous step (file-tail model) | tests-new/model/controller/right-pane-controller-sources.test.ts (+ right-pane-on-intent.test.ts) | skip-as-covered | "No respawnPane on the visible right pane" is the swap-model invariant asserted on every controller path (`respawns…toHaveLength(0)`). |
| tests/integration/hosts/two-pane/right-pane-live-output.test.ts | writes ANSI-colored payloads to the tee (color: true) | tests-new/unit/hosts/tmux-host.test.ts ('does not sendKeys to the right pane — runner bytes flow through the per-step tee (U5)') | skip-as-covered | The tee writes color bytes; the file-session-logger formatter color path is covered by tests-new/unit/observability/file-session-logger.test.ts and the host tee twin. Pane-agnostic. |
| tests/integration/hosts/two-pane/right-pane-live-output.test.ts | registers a file-tail source on step:start (createSession for per-source session with tail command) (U4) | tests-new/model/controller/right-pane-controller-sources.test.ts ('creates a per-source tmux session whose initial pane runs the file-tail argv') | skip-as-covered | Same per-source `live:plan` (`orch-src-live-plan`) createSession with `['tail','-n','5000','-F', <tee>]` argv, asserted at the controller seam. |
| tests/integration/hosts/two-pane/right-pane-live-output.test.ts | left-pane bootstrap respawn is unrelated to the right-pane live path | tests-new/model/controller/right-pane-controller-sources.test.ts | drop | Vacuous: asserts `rightRespawns===0` (covered above) and `leftRespawns>=0` (always true — tautological). No load-bearing content. |

### tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | spawns tail -F over .replay/<step>.txt in a per-source session and swaps in for a commit step | tests-new/model/controller/right-pane-on-intent.test.ts ('prefers the persisted ANSI tee for autonomous replay when the file is non-empty') + right-pane-controller-sources.test.ts (swapPane src→dst) | skip-as-covered | Enter→replay createSession(`orch-src-replay-…`, tail argv) + swapPane(src=createdPane,dst=visible) + no-right-respawn — a controller DECISION re-derived at the FakeTmux seam. |
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | tails .replay/<step>.txt for an autonomous step with no persisted tee (JSON fallback) | tests-new/model/controller/right-pane-on-intent.test.ts ('prefers the persisted ANSI tee for autonomous replay …') (+ tests-new/integration/hosts/plain/transcript-render-claude.test.ts for the re-render) | skip-as-covered | The tee-vs-`.replay` fallback path selection is the on-intent ANSI-tee-preference decision; the JSON re-render content is covered by the transcript-render twin + format-event unit. |
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | does not call newWindow / selectWindow / killWindow / respawnPane(rightPaneId) on any path | tests-new/model/controller/right-pane-on-intent.test.ts (+ right-pane-controller-sources.test.ts, right-pane-controller-lifecycle.test.ts) | skip-as-covered | The window-API-free / no-right-respawn invariant is asserted across the controller twins; the source-invariant static net is the static analogue (also covered). |
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | renders Claude assistant text via toClaudeTranscriptLines when the host wires it as transcriptRenderer | tests-new/integration/hosts/plain/transcript-render-claude.test.ts ('renders the captured NDJSON into a readable plain-text transcript …', asserts `assistant>`) + tests-new/unit/runners/claude/format-event.test.ts | skip-as-covered | The `toClaudeTranscriptLines` → readable `assistant>` (no raw `info:assistant`) renderer decision is covered by the plain transcript-render integration twin + the claude format-event unit. |
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | warm-caches the replay pane: re-Enter on the same step swaps without re-spawning | tests-new/model/controller/right-pane-on-intent.test.ts ('warm-caches the replay pane: re-enter on the same step does not create a second per-source session') | skip-as-covered | Identical warm-cache re-Enter decision (no second createSession) at the controller seam. |
| tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts | swaps to placeholder on follow-live after a prior Enter when no live/rollup is registered | tests-new/model/controller/right-pane-on-intent.test.ts ('on follow-live with no rollup/live registered swaps to placeholder when one exists') | skip-as-covered | Identical follow-live→placeholder swap decision + no-right-respawn at the controller seam. |

### tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts
| tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts | no respawnPane call in src/hosts/two-pane/ targets rightPaneId (use controller.showSource instead) | tests-new/model/controller/right-pane-controller-sources.test.ts, right-pane-on-intent.test.ts, right-pane-controller-replay-dead-pane.test.ts (every path asserts `respawns(rightPaneId)===0`) | skip-as-covered | Static-regex meta-guard for the runtime invariant the controller twins assert dynamically on every visible-pane path (live, replay, follow-live, interactive). The risk (a path respawning the visible slot) is covered dynamically. |
| tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts | exercises the matcher on a synthetic forbidden snippet (self-test) | — | drop | Vacuous self-test of the regex matcher in the deleted meta-guard — asserts nothing about orch behavior. |

### tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts
| tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts | issues no stray sendKeys footer or respawn-cat on the visible right pane while a step is in flight or after it completes | tests-new/model/controller/right-pane-on-intent.test.ts + right-pane-controller-sources.test.ts (no-right-respawn on every path) | skip-as-covered | Post-U8 busy-gate removal is structural (`isRightPaneBusy` deleted from src); the negative invariant (no cat-respawn / no busy footer on the visible pane) is the swap-model no-right-respawn invariant covered by the controller twins. Pane-agnostic. |

### tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts
| tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts | does not double-render or echo ANSI bytes in the visible right pane (file-tail model) | tests-new/unit/hosts/tmux-host.test.ts ('does not sendKeys to the right pane — runner bytes flow through the per-step tee (U5)') + full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts ('autonomous transcript reaches the right pane with no caret echo') | drop | Despite the `.real` name this drives a FakeTmuxService and asserts the same no-right-pane-sendKeys + tee-single-copy + no-caret invariant the U5 host tee twin pins; the kernel-pty echo-doubling it guarded is structurally impossible post-U5 (no sendKeys path to the visible pane). The on-screen no-caret survival is independently covered by the full-host fake-agent swaps-source scenario. Vacuous fake-tmux byte assertion. |


### Cluster C4

# C4 closeout ledger — integration/hosts/two-pane/** plumbing + real-tmux adapter

> Cluster C4 (W5 of Phase 14). Disposition vocab: `skip-as-covered` (cite twin) /
> `demote-relocate` / `re-derive` / `drop`. Genuine real-tmux adapter/mechanics
> tests relocate into `tests-new/integration/real-tmux/<name>.test.ts` preserving
> `describe.skipIf(...)` gating (R13/D8). Controller-decision tests at the
> `FakeTmuxService` seam are `skip-as-covered` by the U7 `model/controller/*`
> twins; lifecycle/process trios by the U8 `tests-new/lifecycle/*` twins.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|

### tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts
| tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts | writes the canonical "resume failed" footer and tails it from a hidden pane | tests-new/model/controller/right-pane-controller-failure-recovery.test.ts (+ model/controller/resume-refusal.test.ts) | skip-as-covered | Mocked `FakeTmuxService` controller test: resume-failure footer → `.replay/` file-tail, no respawn on the visible right pane, no stderr bleed — an error-containment controller DECISION at the fake seam. Passes if the pane is empty. The error-containment + resume-refusal branches are the U7b `failure-recovery` / `resume-refusal` twins. |

### tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts
| tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts | spawns the resume argv as a pty source in a per-source session and swaps it in | tests-new/model/controller/resume-refusal.test.ts | skip-as-covered | Mocked `FakeTmuxService` test: resume `RunnerCommand` argv/env (`--resume <sessionId>`, `FORCE_COLOR=3`, `HOME`) registered as a `pty` per-source session + `swapPane` in, no respawn. This is the resume-refusal twin's `happy path: registry hit + sessionId + resumeCommand spawns the runner` case — a controller DECISION at the fake seam (passes if pane empty). |

### tests/integration/hosts/two-pane/kind-details.integration.test.ts
| tests/integration/hosts/two-pane/kind-details.integration.test.ts | writes commit / worktree / ask payloads to .replay/<step>.txt and tails them on scratch | tests-new/model/controller/right-pane-on-intent.test.ts | skip-as-covered | Mocked `FakeTmuxService` test: kind-details payload → `.replay/<step>.txt` → `file-tail` per-source register on `onIntent('enter')`. This is the `onIntent("enter")` warm-cache / file-tail dispatch DECISION the U7b `right-pane-on-intent` twin pins (passes if pane empty). Old header itself tags it `triage: rewrite … interim Keep`. |

### tests/integration/hosts/two-pane/end-of-run-mount.integration.test.ts
| tests/integration/hosts/two-pane/end-of-run-mount.integration.test.ts | keeps the host alive past workflow completion until awaitForegroundShutdown fires | tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts (+ lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) | skip-as-covered | Mocked-tmux PROCESS-lifecycle assertion: workflow completion alone does not tear the host down; shutdown latches only on a `quit` intent. The host-stays-mounted-past-completion-until-quit plumbing is the U8 `q-intent` lifecycle twin. Passes if pane empty. |
| tests/integration/hosts/two-pane/end-of-run-mount.integration.test.ts | tears down idempotently — second teardown is a no-op | tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts (+ lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) | skip-as-covered | Idempotent teardown (no double kill-session) is process-teardown plumbing proven by the U8 lifecycle teardown twins. Passes if pane empty. |
| tests/integration/hosts/two-pane/end-of-run-mount.integration.test.ts | quit intent fires the canonical shutdown signal exactly once | tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts | skip-as-covered | Quit-intent-fires-shutdown-once (latched tagged deferred, re-await returns `'quit'`) is the U8 `q-intent` lifecycle twin's exact concern. Passes if pane empty. |

### tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts
| tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts | renders the end-of-run footer when the seeded run is in a terminal state | tests-new/integration/real-tmux/end-of-run.test.ts | demote-relocate | Genuine real-tmux: boots a real `tmux` server, spawns the steps-view-runner SUBPROCESS over a seeded `status:'completed'` state.json, polls `capture-pane` for the terminal-state footer + workflow name. `describe.skipIf(!canRunRealTmux())` gating preserved; only import specifiers rewritten (depth 4→3, helpers→`@orch/test/real-tmux`). |

### tests/integration/hosts/two-pane/interactive-unregister-keeps-visible-slot-alive.integration.test.ts
| tests/integration/hosts/two-pane/interactive-unregister-keeps-visible-slot-alive.integration.test.ts | leaves visiblePaneId pointing at a live pane so a subsequent replay swap does not target the killed pane | tests-new/model/controller/right-pane-controller-interactive-dead-pane.test.ts | skip-as-covered | Regression for r-2026-05-11-154533-le run as a `FakeTmuxService` controller test: unregistering a currently-visible interactive source must not leave `visiblePaneId` on a dead pane (lazy placeholder / defensive kill ordering). This is the dead-resume-pane DECISION class the U7b `interactive-dead-pane` twin pins at the fake ownership seam (passes if pane empty). |

### tests/integration/hosts/two-pane/autonomous-live-pane-shows-content-immediately.integration.test.ts
| tests/integration/hosts/two-pane/autonomous-live-pane-shows-content-immediately.integration.test.ts | creates the tee file with non-empty content before any runner events arrive, so tail -F has something to render immediately | tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (+ model/controller/right-pane-controller-sources.test.ts) | skip-as-covered | `FakeTmuxService` host test asserting the starting-marker tee write on `step:start` so `tail -F` is never blank — the autonomous live-source register DECISION (white-box tee bytes, passes with an empty pane). The user-visible "autonomous transcript reaches the live right pane" risk is the U6 full-host `follow-live--right-pane-swaps-source` twin; the register decision is the U7b `sources` twin. |

### tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | creates a per-source session as a sibling of the visible orch session, on the same socket | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux per-source-session mechanics (KTD2/KTD3). skipIf gating preserved; imports rewritten only. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | runs the cat holder argv as the placeholder session initial pane | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux: placeholder session uses the `cat` holder as its initial pane. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | runs the file-tail argv as the initial pane for a non-placeholder source | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux: file-tail argv as a non-placeholder source's initial pane. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | rounds the sanitizer output trip — a colon/dot key produces a session name actually present on the socket | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux: session-name sanitizer round-trips against the live socket. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | teardownSourceSession kills the per-source session and leaves orch alive | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux teardown mechanics. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | teardownSourceSession tolerates double-teardown without erroring | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux idempotent teardown. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | two file-tail per-source sessions can be swapped through the visible pane (cross-session swap-pane) | tests-new/integration/real-tmux/pane-map-source-session.test.ts | demote-relocate | Genuine real-tmux cross-session `swap-pane` smoke. Relocated, gating preserved. |

### tests/integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts
| tests/integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts | translates the dead socket into HostUnavailableError and reports unreachable | tests-new/integration/real-tmux/server-killed-externally.test.ts | demote-relocate | Genuine real-tmux host behaviour (r-2026-05-22-093650-j0): after external `kill-server`, `runInteractive` throws `HostUnavailableError` and `probeReachability()` reports unreachable. `describe.skipIf(!canRunRealTmux())` preserved; imports rewritten only. |
| tests/integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts | records tmuxReachabilityProbeFailed in the lifecycle log on the failure path | tests-new/integration/real-tmux/server-killed-externally.test.ts | demote-relocate | Genuine real-tmux: lifecycle-log `tmuxReachabilityProbeFailed:true` on the dead-socket path. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts | host.teardown() against a dead server completes without throwing | tests-new/integration/real-tmux/server-killed-externally.test.ts | demote-relocate | Genuine real-tmux: teardown against a dead server is non-throwing. Relocated, gating preserved. |

### tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts
| tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts | writes rollup snapshots to the _rollup tee instead of the visible right pane | tests-new/model/controller/right-pane-controller-sources.test.ts (+ model/controller/right-pane-controller-lifecycle.test.ts, unit/hosts/parallel-rollup.test.ts) | skip-as-covered | `FakeTmuxService` host test: rollup payloads go to the `_rollup` meta tee, not the visible right pane (zero `sendKeys`) — a controller wiring DECISION (white-box tee bytes / no-sendKeys, passes if pane empty). Rollup register/teardown decisions are the U7b `sources`/`lifecycle` twins; the rollup payload rendering is `unit/hosts/parallel-rollup.test.ts`. Old header tags it `triage: rewrite … interim Keep`. |
| tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts | registers a file-tail source on step:parallel-start (createSession for the rollup per-source session with tail command) | tests-new/model/controller/right-pane-controller-sources.test.ts | skip-as-covered | Rollup per-source `createSession`/file-tail register on `parallel-start` is the `registerSource` controller DECISION at the fake seam (passes if pane empty). |
| tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts | does not respawn the right pane during a parallel block | tests-new/model/controller/right-pane-controller-sources.test.ts | drop | Vacuous fake-tmux negative invariant ("no respawn on the visible right pane") — passes with an empty pane and asserts the absence of a call; the positive rollup register/swap DECISIONs are covered by the U7b `sources`/`lifecycle` twins. |
| tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts | kills the rollup per-source session on step:parallel-complete (warm cache is live-only) | tests-new/model/controller/right-pane-controller-lifecycle.test.ts | skip-as-covered | Rollup per-source-session teardown on `parallel-complete` (warm cache live-only) is the `teardownSessions`/lifecycle controller DECISION the U7b `lifecycle` twin pins (passes if pane empty). |

### tests/integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts
| tests/integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts | keeps resident-set growth under 120MB on a 10MB synthetic transcript | tests-new/integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts | demote-relocate | Pure-function RSS memory-bound perf guard on `renderTranscriptToString` (`src/hosts/two-pane/replay-transcript.ts`) — not pane-shaped, no two-pane twin, genuinely uncovered. Plain non-pane smoke; relocated same-depth so the body and imports are byte-identical (no specifier rewrite needed). |

### tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts
| tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts | keeps the TUI mounted through workflow completion until quit fires | tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts (+ lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) | skip-as-covered | Mocked `FakeTmuxService`+`FakeProcessService` e2e of the same PROCESS-lifecycle trio as `end-of-run-mount`: stays mounted through completion, `awaitForegroundShutdown` pending until `quit`, teardown in canonical order. Covered by the U8 lifecycle twins; passes if pane empty. |

### tests/integration/hosts/two-pane/steps-view-header-no-duplicate.real.integration.test.ts
| tests/integration/hosts/two-pane/steps-view-header-no-duplicate.real.integration.test.ts | renders the run breadcrumb exactly once after several state changes and pane resizes | tests-new/integration/real-tmux/steps-view-header-no-duplicate.test.ts | demote-relocate | Genuine real-tmux behavioural test (mountTmuxHost + real tmux): the `orch · <workflow> · <runId>` breadcrumb must not stack across state changes/resizes — a no-stale-frame property that needs the real terminal (would not pass if the pane were empty). `describe.skipIf(!canRunRealTmux())` preserved; imports rewritten only. |

### tests/integration/hosts/two-pane/steps-view/steps-tui.real.integration.test.ts
| tests/integration/hosts/two-pane/steps-view/steps-tui.real.integration.test.ts | renders the seeded workflow name and step name into the left pane | tests-new/integration/real-tmux/steps-tui.test.ts | demote-relocate | Genuine real-tmux: boots a real tmux server, spawns the Ink steps-view-runner child onto the left pane, captures and asserts the workflow + step name render. skipIf gating preserved; imports rewritten (depth 5→3) + the runtime `resolve()` runner-script arg corrected by the same specifier rewrite. |

### tests/integration/hosts/two-pane/tier-1/banner-info-and-error-ttl.real.integration.test.ts
| tests/integration/hosts/two-pane/tier-1/banner-info-and-error-ttl.real.integration.test.ts | step:failed renders 'step plan failed' in the steps-view left pane | tests-new/integration/real-tmux/banner-info-and-error-ttl.test.ts | demote-relocate | Genuine full-host-on-real-tmux: `mountTmuxHost` + `FakeRunner` failing step, assert the error banner survives the real host plumbing to the visible left pane (would not pass if pane empty). The banner DECISION is the U7b `banner` twin and the banner bytes are `screen/banner--paint-bytes`, but the end-to-end host-on-real-tmux survival is genuine real-tmux integration. skipIf preserved; imports rewritten only. |

### tests/integration/hosts/two-pane/tier-1/right-pane-shows-failure-summary.real.integration.test.ts
| tests/integration/hosts/two-pane/tier-1/right-pane-shows-failure-summary.real.integration.test.ts | right.capture() contains the failure headline and error message after the step throws | tests-new/integration/real-tmux/right-pane-shows-failure-summary.test.ts | demote-relocate | Genuine full-host-on-real-tmux: `mountTmuxHost` + `FakeRunner` failing step, assert `renderFailurePanePayload` reaches the visible right pane via the tee→warm-replay swap (would not pass if pane empty). Distinct from the left-pane banner test; end-to-end host survival is genuine real-tmux. skipIf preserved; imports rewritten only. |

### tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts
| tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts | list-keys -T root after init exposes WheelUpPane with the nested if-shell shape gating copy-mode entry on both mouse_any_flag and alternate_on | tests-new/integration/real-tmux/wheel-no-mode-error.test.ts | demote-relocate | Genuine real-tmux keytable adapter assertion (`list-keys -T root`). skipIf gating preserved; imports rewritten only. |
| tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts | WheelDownPane in the root table NEVER falls back to copy-mode at the live tail — only WheelUp opens scrollback (regression guard for trapped-in-copy-mode) | tests-new/integration/real-tmux/wheel-no-mode-error.test.ts | demote-relocate | Genuine real-tmux keytable regression guard. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts | copy-mode and copy-mode-vi tables contain ONLY the audited allowlist after init — exit (q/Escape/C-c) and scroll (j/k/Up/Down/PageUp/PageDown/g/G/wheel) — so the user can never get trapped | tests-new/integration/real-tmux/wheel-no-mode-error.test.ts | demote-relocate | Genuine real-tmux copy-mode keytable allowlist audit. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts | the if-shell format strings evaluate against tmux 3.3+ without errors when probed via display-message | tests-new/integration/real-tmux/wheel-no-mode-error.test.ts | demote-relocate | Genuine real-tmux: if-shell format strings evaluate without error on the live server. Relocated, gating preserved. |

### tests/integration/hosts/two-pane/wheel-up-on-ink-prompt-no-copy-mode.real.test.ts
| tests/integration/hosts/two-pane/wheel-up-on-ink-prompt-no-copy-mode.real.test.ts | the visible right pane reports alternate_on == 1 while the prompt is open so the smart-wheel binding does not enter copy-mode | tests-new/integration/real-tmux/wheel-up-on-ink-prompt-no-copy-mode.test.ts | demote-relocate | Genuine real-tmux behavioural test (r-2026-05-22-212450-07): the open ink-prompt pane must report `alternate_on == 1` so the smart-wheel binding skips copy-mode. skipIf preserved; imports rewritten + the runtime `join(here, '..'×4)` REPO_ROOT corrected to `'..'×3` for the new depth (the runner spawn path is computed from file location, not an import specifier). |

### tests/integration/hosts/two-pane/windows.real.integration.test.ts
| tests/integration/hosts/two-pane/windows.real.integration.test.ts | creates a second window via newWindow, leaving list-windows showing two windows | tests-new/integration/real-tmux/windows.test.ts | demote-relocate | Genuine `RealTmuxService` window-lifecycle adapter test against a live tmux server. skipIf gating preserved; imports rewritten only. |
| tests/integration/hosts/two-pane/windows.real.integration.test.ts | selectWindow back to window 0, then killWindow on window 1, leaves only one window | tests-new/integration/real-tmux/windows.test.ts | demote-relocate | Genuine `RealTmuxService` select/kill window adapter test. Relocated, gating preserved. |
| tests/integration/hosts/two-pane/windows.real.integration.test.ts | killWindow tolerates a missing window id (idempotent teardown) | tests-new/integration/real-tmux/windows.test.ts | demote-relocate | Genuine `RealTmuxService` idempotent killWindow adapter test. Relocated, gating preserved. |


### Cluster C5

# C5 closeout ledger — unit/hosts/two-pane decision/coordination tests (demote-relocate)

Cluster C5 (W5): plain non-pane class tests mis-filed under `unit/hosts/two-pane`.
All pass the triage rule ("would it still pass if the pane were empty?" → YES):
they assert classification logic, lifecycle choreography, codec/replay
coordination, and stdio capture — never pane bytes. Default disposition
`demote-relocate`: faithful verbatim copy into the mirror path under `tests-new/`,
import specifiers rewritten only (bodies byte-identical), `import-parity` guard
verifies the relocation contract centrally.

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |

### tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | awaitInteractivePaneExit > resolves via the pane-died hook when the hook signal arrives | tests-new/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | demote-relocate | plain liveness-backstop coordination logic over fake tmux/clock — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | awaitInteractivePaneExit > falls back to the liveness poll when the hook signal is lost, reporting the dead status | tests-new/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | demote-relocate | plain liveness-backstop coordination logic over fake tmux/clock — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | awaitInteractivePaneExit > releases the parked hook waiter via signalChannel when the poll wins | tests-new/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | demote-relocate | plain liveness-backstop coordination logic over fake tmux/clock — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | awaitInteractivePaneExit > keeps waiting while the pane is alive and never fails a live pane | tests-new/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | demote-relocate | plain liveness-backstop coordination logic over fake tmux/clock — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | awaitInteractivePaneExit > treats a vanished pane (display-message throws) as exited | tests-new/unit/hosts/two-pane/await-interactive-pane-exit.test.ts | demote-relocate | plain liveness-backstop coordination logic over fake tmux/clock — pane-agnostic; relocated verbatim, imports only |

### tests/unit/hosts/two-pane/kind-details.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/kind-details.test.ts | renderKindDetails for commit kind > renders the SHA on a CommitResult-shaped value | tests-new/unit/hosts/two-pane/kind-details.test.ts | demote-relocate | pure string-in/string-out presentation formatting — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/kind-details.test.ts | renderKindDetails for commit kind > renders the no-commit fallback when value is null (clean tree) | tests-new/unit/hosts/two-pane/kind-details.test.ts | demote-relocate | pure string-in/string-out presentation formatting — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/kind-details.test.ts | renderKindDetails for worktree kind > renders path / branch / fromRef from a WorktreeResult-shaped value | tests-new/unit/hosts/two-pane/kind-details.test.ts | demote-relocate | pure string-in/string-out presentation formatting — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/kind-details.test.ts | renderKindDetails for ask kind > shows the cancelled marker when the prompt was cancelled | tests-new/unit/hosts/two-pane/kind-details.test.ts | demote-relocate | pure string-in/string-out presentation formatting — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/kind-details.test.ts | renderKindDetails for ask kind > shows the chosen button + scalar fields when the user submitted | tests-new/unit/hosts/two-pane/kind-details.test.ts | demote-relocate | pure string-in/string-out presentation formatting — pane-agnostic; relocated verbatim, imports only |

### tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:start > opens the tee, writes the starting marker, then registers a live file-tail source for an autonomous step | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:start > emits a no-transcript banner and registers no source when no logs directory is configured | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:start > produces no side effects for a non-autonomous step | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:cached > emits a single cached-no-transcript info banner | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:complete > unregisters the live source before closing the tee | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:failed > writes the failure summary, unregisters with the completion banner suppressed, emits the error, then closes the tee | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — step:failed > skips the failure-summary write when the host is already tearing down | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — parallel block > opens the rollup tee and registers a rollup file-tail source on parallel-start | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — parallel block > aggregates every branch update into one rollup snapshot written to the rollup tee | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — parallel block > closes the rollup tee only after unregistering the rollup source on parallel-complete | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — parallel block > resets the rollup aggregator so a later parallel block starts with a fresh snapshot | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — FIFO serialization > settles an earlier event's full effect sequence before a later event's begins | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — FIFO serialization > keeps processing later events after one event rejects, routing the rejection to onSendError | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |
| tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts | LifecycleChoreographer — no controller > still runs the tee effects and never throws when no controller is wired | tests-new/unit/hosts/two-pane/lifecycle-choreographer.test.ts | demote-relocate | lifecycle choreography ordered-call assertions over recording fakes — pane-agnostic; relocated verbatim, helper import → @orch/test/* only |

### tests/unit/hosts/two-pane/replay-command-pane.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/replay-command-pane.test.ts | resolveCommandPaneSource > returns the captured pane log path when the file exists and has bytes | tests-new/unit/hosts/two-pane/replay-command-pane.test.ts | demote-relocate | replay source-resolution coordination over real fs — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-command-pane.test.ts | resolveCommandPaneSource > returns the inline placeholder when paneLogPath is undefined | tests-new/unit/hosts/two-pane/replay-command-pane.test.ts | demote-relocate | replay source-resolution coordination over real fs — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-command-pane.test.ts | resolveCommandPaneSource > returns the inline placeholder when the pane log file is empty | tests-new/unit/hosts/two-pane/replay-command-pane.test.ts | demote-relocate | replay source-resolution coordination over real fs — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-command-pane.test.ts | resolveCommandPaneSource > returns the inline placeholder when the pane log file is missing on disk | tests-new/unit/hosts/two-pane/replay-command-pane.test.ts | demote-relocate | replay source-resolution coordination over real fs — pane-agnostic; relocated verbatim, imports only |

### tests/unit/hosts/two-pane/replay-transcript.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/replay-transcript.test.ts | renderTranscriptToString with the default JSON-fallback renderer > renders assistant info events into the replay payload | tests-new/unit/hosts/two-pane/replay-transcript.test.ts | demote-relocate | transcript codec/render coordination over real fs sidecar — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-transcript.test.ts | renderTranscriptToString with the default JSON-fallback renderer > renders the no-events placeholder when the sidecar contains no parseable events | tests-new/unit/hosts/two-pane/replay-transcript.test.ts | demote-relocate | transcript codec/render coordination over real fs sidecar — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-transcript.test.ts | renderTranscriptToString with the default JSON-fallback renderer > skips malformed lines silently rather than crashing the replay | tests-new/unit/hosts/two-pane/replay-transcript.test.ts | demote-relocate | transcript codec/render coordination over real fs sidecar — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-transcript.test.ts | renderTranscriptToString with an injected runner-shaped renderer > runs every event through the supplied toTranscriptLines instead of the JSON fallback | tests-new/unit/hosts/two-pane/replay-transcript.test.ts | demote-relocate | transcript codec/render coordination over real fs sidecar — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/replay-transcript.test.ts | renderTranscriptToString with an injected runner-shaped renderer > still renders the no-events placeholder when the sidecar is empty even with a custom renderer | tests-new/unit/hosts/two-pane/replay-transcript.test.ts | demote-relocate | transcript codec/render coordination over real fs sidecar — pane-agnostic; relocated verbatim, imports only |

### tests/unit/hosts/two-pane/session-lost-classification.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > classifies the macOS "error connecting to ... (No such file or directory)" shape as session-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > classifies the Linux-style "no server running on ..." shape as session-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > classifies "session not found" with a session name as session-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > classifies "can't find session" as session-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > classifies "lost server" as session-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > matches case-insensitively (tmux/macOS sometimes capitalize "No such file") | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — wild stderr shapes > handles a bare "No such file or directory" in stderr (the canonical macOS connect-time variant) | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > does NOT classify "no space for new pane" — this is in-server, not server-lost | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > does NOT classify "duplicate session" — server is alive, name collision | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > does NOT classify "can't find pane: %99" — pane-level lookup, server alive | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > does NOT classify a generic "tmux: unknown command" error | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > returns false for non-TmuxCommandError instances (plain Error, string, undefined, null) | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/session-lost-classification.test.ts | isSessionLostError — negative cases (must NOT be classified) > returns false for a TmuxCommandError with empty stderr | tests-new/unit/hosts/two-pane/session-lost-classification.test.ts | demote-relocate | pure error-string classification logic — pane-agnostic; relocated verbatim, imports only |

### tests/unit/hosts/two-pane/stdio-capture.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
| --- | --- | --- | --- | --- |
| tests/unit/hosts/two-pane/stdio-capture.test.ts | installStdioCapture > captures console.log output with object formatting | tests-new/unit/hosts/two-pane/stdio-capture.test.ts | demote-relocate | stdio interception/capture coordination over fake sinks — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/stdio-capture.test.ts | installStdioCapture > captures console.warn and console.error as stderr lines | tests-new/unit/hosts/two-pane/stdio-capture.test.ts | demote-relocate | stdio interception/capture coordination over fake sinks — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/stdio-capture.test.ts | installStdioCapture > captures direct stdout.write calls without touching the original stream | tests-new/unit/hosts/two-pane/stdio-capture.test.ts | demote-relocate | stdio interception/capture coordination over fake sinks — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/stdio-capture.test.ts | installStdioCapture > restores console and stdout.write so later writes use the original stream | tests-new/unit/hosts/two-pane/stdio-capture.test.ts | demote-relocate | stdio interception/capture coordination over fake sinks — pane-agnostic; relocated verbatim, imports only |
| tests/unit/hosts/two-pane/stdio-capture.test.ts | installStdioCapture > restore is idempotent and closes the target once | tests-new/unit/hosts/two-pane/stdio-capture.test.ts | demote-relocate | stdio interception/capture coordination over fake sinks — pane-agnostic; relocated verbatim, imports only |

## Helper migration note

`lifecycle-choreographer.test.ts`'s only test-helper dependency,
`tests/helpers/recording-lifecycle-collaborators.ts` (sole consumer = that test),
was copied **byte-identically** into `tests-new/_support/recording-lifecycle-collaborators.ts`
(its own `../../src/...` imports resolve unchanged at the same depth) so the
relocated test's `@orch/test/recording-lifecycle-collaborators.ts` specifier
resolves on disk. The old `tests/helpers/` copy is left untouched (out of this
cluster's file scope) — converting it to a D13/R11 re-export shim, or deleting
it, is W6 shim-lifecycle work.


### Cluster C6

# C6 closeout — four non-relocatable real-tmux/host behavioral demotes + behavioral-dsl launcher smoke

Parent: Phase 14 group-B closeout (W4 + the behavioral-dsl launcher smoke), plan
§5 W4 + decision **P14-D5**; ledger "Open accounting gap — (b) Non-relocatable
Category-A behavioral demotes". Disposition vocab: `skip-as-covered` (twin cited,
verified on disk) / `drop` (reason required) / `re-derive` (gated real scenario).

Default per P14-D5 for the four real-tmux/host files: **skip-as-covered + drop** —
cite the existing COMPONENT twin that covers the unit-level behavior with fakes,
and drop the end-to-end host-wiring / real-tmux-race assertion (no faithful fake
substrate; re-deriving the gated real-tmux scenario is disproportionate). **No new
fake stop-channel / fake command-host substrate was built** (forbidden — the Phase
13 trap). **No new gated scenario was authored**: the one headline real-fidelity
case that warranted re-derivation (interactive auto-stop closes the pane with no
keystroke) was **already re-derived in Phase 9** at
`tests-new/full-host/real-agent/auto-stop.test.ts`, so C6 cites it rather than
duplicating it.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|

### tests/integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| auto-stop.real.integration.test.ts | closes itself when the stop channel is signaled, with no manual close | tests-new/full-host/real-agent/auto-stop.test.ts | skip-as-covered | The headline end-to-end behavior (a finished interactive turn fires the real Stop hook → `tmux wait-for` → orch closes the pane with NO keystroke) is already re-derived at real fidelity in the Phase 9 gated `full-host:real-agent` smoke `an interactive auto-stop step finishes its turn and the pane closes with no keystroke`. Auto-stop WIRING (arm/signal/terminate) additionally covered by `tests-new/unit/core/workflow-auto-stop.test.ts`. |
| auto-stop.real.integration.test.ts | records armed → signaled → terminated lifecycle events in order | — | drop | The armed→signaled→terminated lifecycle WIRING is covered as a unit by `tests-new/unit/core/workflow-auto-stop.test.ts`. Dropped end-to-end assertion: the *real-tmux* ordered `wait-for` stop-channel event sequence observed through the real host. No faithful fake substrate (`createFakeHost` has no stop-channel — building one is re-derivation forbidden by P14-D5); re-deriving a gated per-event-order real-tmux scenario is disproportionate to the unit coverage already in place. |
| auto-stop.real.integration.test.ts | resolves via pane-exit when an armed autoStop pane is manually closed, with no stop signal | — | drop | Auto-stop arm/resolve WIRING covered by `tests-new/unit/core/workflow-auto-stop.test.ts`. Dropped end-to-end assertion: the real PTY **pane-exit RACE** (an armed pane that resolves via manual pane-exit *before* any stop signal). This needs a real tmux pane lifecycle; no faithful fake exists, and a gated race scenario is disproportionate (P14-D5). |
| auto-stop.real.integration.test.ts | a step without autoStop never arms and ignores a stop-channel signal | — | drop | The "no-autoStop step never arms / ignores a stop signal" decision is covered as a unit by `tests-new/unit/core/workflow-auto-stop.test.ts` (auto-stop wiring is gated on the step opting in). Dropped end-to-end assertion: that the real-tmux stop-channel signal is ignored by a non-armed host pane. No faithful fake stop-channel substrate (P14-D5); gated re-derivation disproportionate. |

### tests/integration/lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts | writes session.json and events.ndjson for each completed step | tests-new/unit/observability/file-session-logger.test.ts | skip-as-covered | Per-step disk-persistence component behavior (session.json + events.ndjson emitted per completed step) is covered by the `file-session-logger` component twin `tests-new/unit/observability/file-session-logger.test.ts`, with the baseline integration twin `tests-new/integration/observability/session-logger-baseline.integration.test.ts` exercising the logger+store on disk. Dropped end-to-end assertion: that these artifacts land "via the REAL host's logger+store wiring through a driven subprocess" — fakes would need that host wiring assembled (re-derivation, no faithful substrate, P14-D5); the component twins prove the unit behavior. |

### tests/integration/lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts | cached plan survives across runs; execute re-runs and the resumed run completes | tests-new/integration/observability/resume-per-step-folder.test.ts | skip-as-covered | Resume component behavior — cached per-step folders survive across runs and replay — is covered by `tests-new/integration/observability/resume-per-step-folder.test.ts`; the controller-side resume decision (cached-glyph / refusal) is covered by `tests-new/model/controller/resume-refusal.test.ts`. Dropped end-to-end assertion: the resume **orchestration proven through the real driven host** (a full cross-run replay driven via the real subprocess host). A faithful fake would need the same host wiring assembled (re-derivation forbidden, P14-D5); the component twins cover the unit behavior. |

### tests/integration/lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts | command stdout streams to disk and state.json records exitCode 0 | tests-new/unit/core/command.test.ts | skip-as-covered | Command-step component behavior is covered by the command twins: `tests-new/unit/core/command.test.ts` (command step semantics), `tests-new/integration/core/command-mocked.test.ts` (command step at the integration edge), and `tests-new/unit/hosts/plain/per-step-tee.test.ts` (per-step stdout tee → disk). Dropped end-to-end assertion: that command stdout streams to the right pane **through the real command-host pipe-pane fixture**. That fixture (a `command(...)` step + pipe-pane capture) **does not exist** in `tests-new/_support/real-tmux/` (per the U6 ledger note); building a fake command-host substrate is forbidden (P14-D5), so the end-to-end host pipe assertion is dropped while the component tee/exit-code behavior is covered. |

### tests/integration/behavioral-dsl/launch-smoke.real.test.ts

The old behavioral-dsl real launcher smoke. The new full-host DSL fixtures
(`app.launch` boots the fixture + parses runId + reserves an isolated socket;
`app.complete` holds/releases steps; the driver tears the host down) supersede it.
The old behavioral-dsl harness is being retired (its `_support` copy is a shim
slated for deletion) — **not relocated** (D-per-prompt).

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| launch-smoke.real.test.ts | boots the fixture, parses runId, lands on a reserved socket, and exposes the rawStreams handle | tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | skip-as-covered | Booting a fixture, parsing the runId, landing on the reserved isolated test socket, and exposing the driven-host handle is exactly what every full-host driver scenario does via `app.launch(...)`. Covered by the full-host fixtures (e.g. `tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts` and siblings under `tests-new/full-host/fake-agent/`, and the gated `tests-new/full-host/real-agent/` smokes). The runId-format / socket-reservation assertions were old-harness `launchOrchWorkflow` handle internals; the surviving behavior (a real isolated host boots and runs) is covered by the driver. |
| launch-smoke.real.test.ts | drives a held step to mid-run, releases it via the gate file, and finishes | tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | skip-as-covered | Driving a step to mid-run, releasing it, and finishing the run is the core full-host plumbing the DSL exercises (`app.launch` → step holds → `app.complete(<step>)` releases and the run finishes). Covered by the full-host fixtures under `tests-new/full-host/fake-agent/` (multi-step / follow-live / replay scenarios all hold and release steps). The raw `state.json` status/`endedAt` polling was old-harness mechanics, superseded by the driver's `app.complete` step-progression semantics. |
| launch-smoke.real.test.ts | teardown is idempotent and removes the isolated stateBase | tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | skip-as-covered | Per-scenario isolated-stateBase teardown is performed by the full-host driver after every scenario (every `tests-new/full-host/fake-agent/*` and `tests-new/full-host/real-agent/*` scenario relies on it). Idempotent teardown of the isolated stateBase is a property of the new driver, not a behavior needing its own old-harness assertion. |
| launch-smoke.real.test.ts | throws a clear error when the fixture name is not registered | — | drop | Pure old-harness API assertion: `launchOrchWorkflow('does-not-exist')` rejects. This tests the retiring behavioral-dsl `_support` shim's own fixture-registry guard, not any orch behavior. The shim is slated for deletion (W6); the full-host DSL has no equivalent public unregistered-fixture API surface to re-derive against. Dropped with no covering twin needed — it asserts the dead harness, not the product. |



---

## Phase 15 handoff (parent U14 — reconciliation + gate flip)

Phase 14 (group-B closeout) closed the migration gap and built the forward core of
the U14 reconciliation oracle. What Phase 15 (parent U14) still owns:

1. **Promote `reconcile.ts` to blocking + add assertions #4–#6.** Today it ships
   non-blocking (`bun run reconcile`, not on `check`) and implements #1 (skip-
   completeness, the load-bearing oracle), #3 (marker-target existence), and a
   **non-blocking** #2 (ledger-completeness — currently reports ~2.2k "unledgered"
   names because the prose ledger abbreviates many U10–U13 relocation paths/case
   names; **normalise the ledger to a machine-keyed table first**, then make #2
   strict). Add #4 (overlap report green for the *whole* suite — wire `bun run
   overlap-report` into the assertion), #5 (`check`/`check:release` green pointing at
   `tests-new/`), #6 (docs **and** `.claude/skills/**` tier-grep clean repo-wide).
2. **Flip the default gate onto `tests-new/`.** Repoint `test`/`check` per parent §8
   (`test:new-unit`/`test:new-int`/`test:new-e2e` + `test:two-pane`), and rename the
   all-`.skip` old tree script to `test:legacy-archive`.
3. **Update `docs/plans/implementation-phases.md`** to record the restructure as landed.

### ⚠️ Blocker discovered in Phase 14 — the four `_support` shims are NOT deletable yet (W6 deferred)

W6 ("delete the four D13 re-export shims": `make-step-entry`, `fake-host`, `real-tmux`,
`behavioral-dsl`) **could not be done** and is deferred. The W6 premise — that W3–W5
skipped the *last* live consumer of each shim — is **false**: these shims are imported
**tree-wide**, not just by group-B files (`fake-host` 44 consumers, `real-tmux` 72,
`behavioral-dsl` 42, `make-step-entry` 19 — mostly core/state/cli/observability/lifecycle
old tests this phase never touched).

**The load-bearing fact (verified empirically):** a `describe.skip` file *still resolves
its top-level `import`s at load time* — Bun loads the module and errors on a missing
specifier even when the whole suite is skipped. So a shim stays required as long as **any**
old file that imports it is still *loaded by a runner*, regardless of `.skip`. Deleting a
shim now breaks `test:legacy` at module-load.

**Consequence for Phase 15:** the shims are deletable only once the old `tests/` tree is
**no longer loaded by any script**. The parent §7 plan keeps a `test:legacy-archive` that
*runs the all-`.skip` old tree as a cheap record* — which still loads it, so even after the
gate flip the shims must stay unless `test:legacy-archive` is also dropped. Phase 15 should
decide explicitly: either (a) keep the four shims KEPT forever alongside the archived old
tree (they cost nothing), or (b) drop `test:legacy-archive` entirely (stop loading the old
tree) and *then* delete the shims. Recommendation: **(a)** — the shims are 5-line re-exports
and the archive's grep-able record is worth more than their removal. Status unchanged from
pre-Phase-14: **all four KEPT.**

> Minor hygiene note (C5): the relocation of `lifecycle-choreographer` needed
> `recording-lifecycle-collaborators` under `_support`, so Phase 14 added
> `tests-new/_support/recording-lifecycle-collaborators.ts` (byte-identical copy). The old
> `tests/helpers/recording-lifecycle-collaborators.ts` is left in place (still imported by
> its now-skipped old consumer). Converting it to a re-export shim is optional Phase-15
> hygiene, same lifecycle as the four shims above.
