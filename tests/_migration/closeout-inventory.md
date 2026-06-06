# Phase 14 group-B closeout — inventory (RESOLVED)

> **Status: RESOLVED (W7).** Every still-live group-B baseline case enumerated
> here has a final disposition in the ledger's *"Phase 14 — group-B closeout"*
> section, its owning old file is wrapped `describe.skip` + a marker (D2), and
> the frozen-baseline scanner `tests-new/_migration/reconcile.ts` reports
> **zero** unaccounted baseline `test` cases (`bun run reconcile`).

## What this worksheet is

The authoritative, baseline-grounded list (W1) of the group-B files U13 left LIVE
and un-dispositioned. It is derived from the **frozen U1 baseline**
(`baseline.json`, D12) cross-referenced against on-disk `.skip` ancestry — not the
prose "(a)+(b)" gap list, which was provably incomplete. The closeout (W3–W6)
dispositioned **224 cases across 57 files**; the per-case detail lives in the
ledger. This file is the per-file index.

## Disposition vocabulary (P14-D4)

- `skip-as-covered` — a `tests-new/` twin already proves the risk (cited per case
  in the ledger; `reconcile.ts` #3 asserts the cited marker target exists).
- `demote-relocate` — a pane-agnostic class/coordination test relocated verbatim
  into `tests-new/{unit,integration}/…` (import-parity guard green over all pairs).
- `re-derive` — a genuinely-uncovered risk re-authored as a DSL scenario (none
  were needed: the closeout was a pure pruning re-derivation; every risk was
  already re-derived in U5–U9).
- `drop` — a vacuous / tautological / fake-tmux-byte assertion, dropped with a
  reason recorded in the ledger.

## Per-file index (57 files, 224 cases)

| Cluster | Old file (under tests/) | Cases | Disposition mix |
|---|---|---|---|
| C1 | unit/hosts/two-pane/steps-view/steps-view.test.tsx | 10 | 5 skip-as-covered, 5 drop |
| C1 | unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx | 9 | 9 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx | 13 | 13 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx | 8 | 8 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx | 4 | 4 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/header-rerender.test.tsx | 1 | 1 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx | 4 | 4 skip-as-covered |
| C1 | unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx | 2 | 2 drop |
| C1 | unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx | 7 | 7 skip-as-covered |
| C2 | unit/hosts/two-pane/steps-view/steps-view-model.test.ts | 12 | 12 demote-relocate |
| C2 | unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts | 8 | 8 demote-relocate |
| C2 | unit/hosts/two-pane/steps-view/adaptive-columns.test.ts | 2 | 2 skip-as-covered |
| C2 | unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts | 4 | 4 skip-as-covered |
| C2 | unit/hosts/two-pane/steps-view/start-steps-view.test.ts | 9 | 9 demote-relocate |
| C2 | unit/hosts/two-pane/steps-view/tail-ndjson.test.ts | 3 | 3 demote-relocate |
| C2 | unit/hosts/two-pane/steps-view/tail-state-json.test.ts | 3 | 3 demote-relocate |
| C3 | integration/hosts/two-pane-mocked.test.ts | 4 | 4 demote-relocate |
| C3 | integration/hosts/two-pane-interactive.test.ts | 1 | 1 skip-as-covered |
| C3 | integration/hosts/two-pane-sequential-runs.test.ts | 3 | 3 demote-relocate |
| C3 | integration/hosts/two-pane-failure-and-parallel.test.ts | 2 | 2 skip-as-covered |
| C3 | integration/hosts/two-pane-interactive-session-lost.test.ts | 1 | 1 demote-relocate |
| C3 | integration/hosts/two-pane/right-pane-live-output.test.ts | 5 | 4 skip-as-covered, 1 drop |
| C3 | integration/hosts/two-pane/right-pane-replay.integration.test.ts | 6 | 6 skip-as-covered |
| C3 | integration/hosts/two-pane/right-pane-source-invariant.test.ts | 2 | 1 skip-as-covered, 1 drop |
| C3 | integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts | 1 | 1 skip-as-covered |
| C3 | integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts | 1 | 1 drop |
| C4 | integration/hosts/two-pane/resume-failure-mocked.integration.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/kind-details.integration.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/end-of-run-mount.integration.test.ts | 3 | 3 skip-as-covered |
| C4 | integration/hosts/two-pane/end-of-run.real.integration.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/interactive-unregister-keeps-visible-slot-alive.integration.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/autonomous-live-pane-shows-content-immediately.integration.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts | 7 | 7 demote-relocate |
| C4 | integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts | 3 | 3 demote-relocate |
| C4 | integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts | 4 | 3 skip-as-covered, 1 drop |
| C4 | integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts | 1 | 1 skip-as-covered |
| C4 | integration/hosts/two-pane/steps-view-header-no-duplicate.real.integration.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/steps-view/steps-tui.real.integration.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/tier-1/banner-info-and-error-ttl.real.integration.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/tier-1/right-pane-shows-failure-summary.real.integration.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/wheel-no-mode-error.real.test.ts | 4 | 4 demote-relocate |
| C4 | integration/hosts/two-pane/wheel-up-on-ink-prompt-no-copy-mode.real.test.ts | 1 | 1 demote-relocate |
| C4 | integration/hosts/two-pane/windows.real.integration.test.ts | 3 | 3 demote-relocate |
| C5 | unit/hosts/two-pane/await-interactive-pane-exit.test.ts | 5 | 5 demote-relocate |
| C5 | unit/hosts/two-pane/kind-details.test.ts | 5 | 5 demote-relocate |
| C5 | unit/hosts/two-pane/lifecycle-choreographer.test.ts | 14 | 14 demote-relocate |
| C5 | unit/hosts/two-pane/replay-command-pane.test.ts | 4 | 4 demote-relocate |
| C5 | unit/hosts/two-pane/replay-transcript.test.ts | 5 | 5 demote-relocate |
| C5 | unit/hosts/two-pane/session-lost-classification.test.ts | 13 | 13 demote-relocate |
| C5 | unit/hosts/two-pane/stdio-capture.test.ts | 5 | 5 demote-relocate |
| C6 | integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts | 4 | 1 skip-as-covered, 3 drop |
| C6 | integration/lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts | 1 | 1 skip-as-covered |
| C6 | integration/lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts | 1 | 1 skip-as-covered |
| C6 | integration/lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts | 1 | 1 skip-as-covered |
| C6 | integration/behavioral-dsl/launch-smoke.real.test.ts | 4 | 3 skip-as-covered, 1 drop |

## Outcome

- **0** `re-derive` (pure pruning — coverage already existed).
- **26** files `demote-relocate`d (pane-agnostic logic / genuine real-tmux), added
  to `relocation-map.json`; import-parity green over all 268 pairs.
- The remainder `skip-as-covered` (cited twin) or per-case `drop` (reason).
- `reconcile.ts` (#1 skip-completeness, #3 marker-target existence) green;
  overlap report green; `#2` ledger-completeness reported non-blocking (P14-D3).
