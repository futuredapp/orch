---
date: 2026-05-12
status: active
type: audit
topic: tiered-testing-strategy-two-pane
plan: docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-plan.md
---

# Audit: Tiered Testing Strategy — `tests/{unit,integration}/hosts/two-pane/**`

## Triage rule (R8 verbatim)

> **Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete.**

Three dispositions:

- **Keep** — no higher tier covers the bug class this test protects, OR the test is a Tier 3 argv contract test on the tmux seam (out of audit scope per the plan, but mentioned explicitly for completeness).
- **Rewrite** — exercises real behavior but asserts on `FakeTmuxService.recordedCalls` (or an equivalent implementation-detail proxy). Rewrite to assert on visible-pane outcome (Tier 1, via `tests/helpers/real-tmux/`) or projection (Tier 2, via `<StepsView>` + `renderToString`).
- **Delete** — re-states implementation detail and the bug class is already covered (or scheduled to be covered) at a higher tier.

## Tier definitions (R1 verbatim)

- **Tier 1** — real-tmux behavioral. Boots a real tmux server via `createRealTmuxFixture` + `mountTmuxHost`, drives a workflow through the host with a `FakeRunner` agent slot, and asserts on `right.capture()` / `left.capture()`. Covers visible-pane content + view state.
- **Tier 2** — Ink projection. `renderToString` or `ink-testing-library` against a hand-rolled `StepsViewState` fixture. Covers state→view, key→intent, footer/banner.
- **Tier 3** — argv contract. `RealTmuxService` + `FakeProcessService` argv-shape assertions on the tmux seam. Out of this audit's scope (lives under `tests/unit/services/tmux/` and adjacent — not touched by this plan).
- **Tier 4** — real-tmux + real-CLI E2E. Same harness as Tier 1; the agent slot is a real `ClaudeRunner` / `CodexRunner`. Env-gated by `RUN_REAL_TMUX_E2E=1` + `Bun.which('claude'|'codex')`.

## Triage flagging policy

- Any test that mocks `src/{core,state,validators,runners}` is flagged for **mandatory Rewrite or Delete** (CLAUDE.md rule 3). None of the audited files violate this — the host- and view-level tests consistently inject `*Service` ports rather than `mock.module`.
- Tier 1 / Tier 2 starter sets landed in this plan (`tests/integration/hosts/two-pane/tier-1/*` and `tests/unit/hosts/two-pane/steps-view/{view-mode-footer,key-intent-mapping,banner-rendering,end-of-run-footer,empty-steps-state}.test.tsx`) are the canonical replacements referenced by Rewrite/Delete justifications below.

---

## Audit table — `tests/unit/hosts/two-pane/**` (20 files)

| File | Disposition | Tier | Bug class | Justification |
| --- | --- | --- | --- | --- |
| `kind-details.test.ts` | **Keep** | Tier 2 | Right-pane kind-details rendering (commit / worktree / ask) | Pure projection — string-in/string-out. Already at the right tier; no higher tier supersedes. |
| `replay-command-pane.test.ts` | **Keep** | Tier 2 | `resolveCommandPaneSource` decision logic | Pure resolver; no tmux state. No higher tier supersedes. |
| `replay-transcript.test.ts` | **Keep** | Tier 2 | `renderTranscriptToString` event → ANSI lines | Pure renderer. No higher tier supersedes; the visible-pane outcome is the *rendered* string, asserted here. |
| `stdio-capture.test.ts` | **Keep** | Tier 2 | stdio capture writes via FsService | Pure unit, no tmux. No higher tier supersedes. |
| `pane-map/right-pane-controller-banner.test.ts` | **Rewrite** | Tier 2 | Banner emission + view-mode side effects | Currently asserts on controller-internal state. Bug class is now covered at Tier 2 (`banner-rendering.test.tsx`) — keep the controller-side assertion only for paths Tier 2 cannot reach (e.g., `seq` ordering across emit calls). |
| `pane-map/right-pane-controller.test.ts` | **Rewrite** | Tier 1 | Pane-map register/show/unregister wiring | The visible-pane outcome (swap to live source, warm-cached replay) is covered at Tier 1 (`autonomous-live-pane-shows-content`, `replay-revisit-reuses-pane`). This unit test still has value as a controller-level seam test — keep the assertions that exercise control flow `recordedCalls` cannot prove (idempotency, missing-source paths). |
| `pane-map/right-pane-on-intent.test.ts` | **Rewrite** | Tier 1 / Tier 2 | `onIntent('enter')` per-kind dispatch | The dispatch *outcomes* (right pane shows replay for autonomous, kind-details for commit, …) are Tier 1 territory. The intent → action mapping itself is Tier 2 (`key-intent-mapping.test.tsx`). Rewrite to assert on the resulting view shape, not the recorded dispatch. |
| `steps-view/adaptive-columns.test.ts` | **Keep** | Tier 2 | Adaptive-column threshold picker | Pure function. No higher tier supersedes. |
| `steps-view/applyLifecycleEvent.test.ts` | **Keep** | Tier 2 | Lifecycle-event fold on the model | Pure function, no tmux. No higher tier supersedes. |
| `steps-view/start-steps-view.test.ts` | **Keep** | Tier 2 | Daemon lifecycle (start/stop/spawn) | Asserts on host port calls + child lifecycle. Real-tmux equivalent would add ceremony without strengthening the assertion. |
| `steps-view/steps-view-model.test.ts` | **Keep** | Tier 2 | `projectStepsView` projector | Pure projector; the visible-pane outcome flows through this. No higher tier supersedes. |
| `steps-view/tail-ndjson.test.ts` | **Keep** | Tier 2 | NDJSON tail against real fs | Pure unit. No higher tier supersedes. |
| `steps-view/tail-state-json.test.ts` | **Keep** | Tier 2 | state.json tail against real fs | Pure unit. No higher tier supersedes. |
| `steps-view/tui-overlay.test.ts` | **Keep** | Tier 2 | Parent → child IPC wire format | Pure encoding. No higher tier supersedes. |
| `steps-view/end-of-run-summary.test.tsx` | **Keep** | Tier 2 | `<EndOfRunSummary>` + `<EndOfRunFooter>` rendering | Pure projection. Now overlapping with the new `end-of-run-footer.test.tsx`; keep both — this file pins component-level shape, the new one pins state→footer routing. |
| `steps-view/end-of-run-summary-colors.test.tsx` | **Keep** | Tier 2 | Status-label color assertions | Color is a deliberate published affordance. Pure projection. |
| `steps-view/selection.test.tsx` | **Keep** | Tier 2 | `useStepsSelection` hook | Pure hook with no tmux. No higher tier supersedes. |
| `steps-view/steps-view-banner.test.tsx` | **Rewrite** | Tier 2 | Banner + view-mode footer on `<StepsView>` | Now superseded by `banner-rendering.test.tsx` + `view-mode-footer.test.tsx`. Rewrite this file to focus on the *interaction* between banner and view-mode (e.g., banner does not displace footer indicator) — the slice the new files do not cover. |
| `steps-view/steps-view-colors.test.tsx` | **Keep** | Tier 2 | `<StepsView>` color assertions | Color is published affordance; pure projection. |
| `steps-view/steps-view.test.tsx` | **Keep** | Tier 2 | Frame-snapshot tests for `<StepsView>` | Existing canonical projection tests. Overlap with the new Tier 2 starter is intentional — each file pins a different slice. |

---

## Audit table — `tests/integration/hosts/two-pane/**` (19 files)

| File | Disposition | Tier | Bug class | Justification |
| --- | --- | --- | --- | --- |
| `autonomous-live-pane-shows-content-immediately.integration.test.ts` | **Rewrite** | Tier 1 | Autonomous step:start writes a starting marker so the live pane is never blank | Currently asserts on the tee file path existing + having bytes — a file-existence proxy for "the visible pane shows content immediately." Tier 1 (`autonomous-live-pane-shows-content`) now asserts the visible-pane outcome directly. Rewrite to use the harness, OR delete and rely on Tier 1. Recommend Rewrite as a starting-marker invariant the Tier 1 test does not pin (Tier 1 only requires bytes appear within a window; this file pins the starting marker is the *first* byte). |
| `end-of-run-mount.integration.test.ts` | **Keep** | Integration (Tier 1-adjacent) | Mocked-tmux end-of-run mount lifecycle | Asserts on host lifecycle calls under FakeTmuxService. The real-tmux variant (`end-of-run.real.integration.test.ts`) covers the same bug class. Keep both — the mocked variant runs in every `bun run check` regardless of tmux availability. |
| `end-of-run.real.integration.test.ts` | **Keep** | Tier 1 | End-of-run footer on real tmux | Prior art the harness was generalized from. Tier 1 starter (`view-mode-footer-reflects-mode.real.integration.test.ts`) covers the same bug class via the harness, so this file is now duplicative. Mark Keep for now — it remains green and proves the underlying ceremony; consider Delete after the harness has shipped longer and Tier 1 is established. |
| `follow-live-prefers-live-over-interactive-replay.integration.test.ts` | **Rewrite** | Tier 1 + Tier 2 | Follow-live (`f`) prefers live over interactive replay | Asserts on FakeTmuxService recorded calls. Bug class is named in R9 as Tier 1; the projection-layer slice (intent → view-mode flip) is named in R10 as Tier 2 (`key-intent-mapping.test.tsx`). Tier 1 deterministic version is currently deferred (see `follow-live-returns-to-running-step.real.integration.test.ts`); Rewrite to cover the controller-level interaction this file uniquely exercises. |
| `interactive-unregister-keeps-visible-slot-alive.integration.test.ts` | **Keep** | Integration | Interactive step exit does not collapse the visible right pane | Tier 1 cannot reproduce this (FakeRunner cannot drive a real interactive PTY). Tier 4 covers the visible outcome; this mocked test covers the controller's placeholder-pane fallback path Tier 4 cannot fail-isolate. |
| `kind-details.integration.test.ts` | **Rewrite** | Tier 1 | Commit/worktree/ask kind-details panel | Asserts on FakeTmuxService recorded swaps. The visible outcome (right pane shows the rendered kind-details text) is Tier 1 territory once the harness gains an "enter on a completed non-agent step" helper. Rewrite — interim Keep is acceptable. |
| `pane-map-scratch-session.real.integration.test.ts` | **Keep** | Tier 1 / integration | Scratch session + swap-between-two-tails | Real-tmux test that pins the scratch session helper + swap mechanics. Tier 1 starter doesn't replicate this — keep. |
| `resume-failure-mocked.integration.test.ts` | **Keep** | Integration | Resume failure paths | Tier 1 cannot exercise resume (workflow.resume requires existing state files + cooperating agents); this mocked test is the only place the failure paths are pinned. |
| `resume-launcher-mocked.integration.test.ts` | **Keep** | Integration | Swap-based resume path | Same reasoning as `resume-failure-mocked` — Tier 1 cannot reproduce. |
| `right-pane-busy-gate.integration.test.ts` | **Keep** | Integration | Post-U8 "no busy gate" invariant | Asserts absence of a deprecated path. Tier 1 cannot prove absence — keep. |
| `right-pane-live-doubling.real.integration.test.ts` | **Delete** | (covered by Tier 1) | Pty echo doubling of ANSI bytes | Caret-notation check is now pinned in `autonomous-live-pane-shows-content.real.integration.test.ts`. The recordedCalls assertions here are implementation-detail; the visible-pane outcome (no `^[` in the captured pane) is exactly what the Tier 1 starter asserts. Delete after U6 confirms the Tier 1 test is stable. |
| `right-pane-live-output.test.ts` | **Rewrite** | Tier 1 | Live path file-tail-source registration | Multi-scenario file. Some scenarios assert on `splitPane(tail …)` argv shape — these are Tier 3-flavored seam tests, keep at this tier. Other scenarios assert "no sendKeys on visible right pane" — Tier 1 visible-pane assertion supersedes. Rewrite the file to split the two slices cleanly. |
| `right-pane-replay.integration.test.ts` | **Rewrite** | Tier 1 | Swap-based replay path | Drives the real `right-pane-controller` and asserts on FakeTmuxService recorded swaps. Tier 1 starter (`replay-shows-same-transcript-as-live.real.integration.test.ts`) covers the visible outcome. Rewrite this file to cover the controller-level fallback paths (refusal text, missing tee) Tier 1 cannot easily reach. |
| `right-pane-source-invariant.test.ts` | **Keep** | Integration | Cross-cutting "no respawnPane on visible right pane" invariant | This is a system-wide invariant guard, not a per-feature test. Tier 1 cannot prove absence across all paths — keep. |
| `steps-tui-e2e.mocked.test.ts` | **Keep** | Integration | Mocked end-to-end steps-TUI run | Mocked-tmux variant of the real e2e file. Always runs in `bun run check`. The real-tmux variant (`steps-view/steps-tui.real.integration.test.ts`) covers the visible-pane outcome. |
| `tmux-host-rollup-pane-map.integration.test.ts` | **Rewrite** | Tier 1 | Parallel rollup hidden pane + auto-swap | Asserts on FakeTmuxService recorded calls. The visible outcome (rollup pane shows aggregated status) is Tier 1 territory once the harness gains a "drive a parallel block" helper. Interim Keep, plan Rewrite. |
| `transcript-replay-memory.smoke.test.ts` | **Keep** | Integration (smoke) | Memory ceiling for 10MB transcript replay | Performance smoke — not a visible-pane assertion. No higher tier supersedes. |
| `windows.real.integration.test.ts` | **Keep** | Tier 1-adjacent | Window create/select/kill dance | Real-tmux test for window operations. Adjacent to Tier 1 scope (windows, not panes). No higher tier supersedes. |
| `steps-view/steps-tui.real.integration.test.ts` | **Keep** | Tier 1 | Real-tmux steps-view daemon boot | Prior art for the steps-view real-tmux path. Tier 1 starter (`view-mode-footer-reflects-mode.real.integration.test.ts`) covers a slice of this; full daemon-boot coverage is unique to this file. |

---

## Files Tier 4 will migrate (out-of-table reference)

These are in `tests/e2e/` (not in this audit's scope, but explicitly named in R12):

- `tests/e2e/resume-real-claude.test.ts` — migrate onto `createRealTmuxFixture` in U7.
- `tests/e2e/steps-tui-e2e.test.ts` — migrate onto the harness in U7.

---

## Disposition summary

- **Keep**: 27 files (Tier 2 projection, Tier 3-adjacent argv, integration paths Tier 1 cannot reach).
- **Rewrite**: 11 files (visible-outcome assertions exist but pivot through `recordedCalls`).
- **Delete**: 1 file (`right-pane-live-doubling.real.integration.test.ts`) — pending U6 confirmation that Tier 1 covers the bug class robustly.

U6 applies these dispositions in batches. Each Rewrite + Keep file gets a `// triage: keep|rewrite — <reason>` header during U6 so the disposition is grep-able from the file itself.
