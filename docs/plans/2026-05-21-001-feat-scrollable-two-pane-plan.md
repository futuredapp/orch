---
title: Scrollable Two-Pane TUI
type: feat
status: completed
date: 2026-05-21
origin: docs/brainstorms/2026-05-21-feat-scrollable-two-pane-requirements.md
---

# Scrollable Two-Pane TUI

## Summary

Narrowly amend the strict-sandbox appliance: extend the existing `ALLOWLIST` with two wheel bindings governed by an `if-shell -F` smart-wheel rule, raise `history-limit` to 50,000 in the generated `-f` config, default Codex interactive to `--no-alt-screen` in `buildInteractiveArgv`, and add a `scrollOffset` field to `StepsViewStateBase` so the existing `ViewModeFooter` carries a "scrolled vs live tail" indicator. Claude Code stays untouched in code — `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` is documentation-only, delivered by the existing `mergeEnv` passthrough.

---

## Problem Frame

The strict-sandbox decision (see origin, and `docs/plans/2026-05-05-feat-tmux-strict-appliance-mode-plan-v2.md`) forced `history-limit 0` and `unbind-key -a` across all key tables to kill a `not in a mode` regression. Upstream movement since then — tmux's `mouse_any_flag` / `alternate_on` format strings, Codex shipping `--no-alt-screen` in PR openai/codex#8555 (now available on the pinned `MIN_CODEX_VERSION = 0.118.0`), and Claude Code honoring `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` — makes the wheel + history-limit reversal safe. The Ink left pane needs separate treatment because `alternateScreen: true` on the Ink canvas means tmux scrollback never sees the left pane's history (only the latest frame).

---

## Requirements

**Right pane — wheel and scrollback**

- R1. Wheel events forward to the running app via `send-keys -M` when the app has asserted mouse tracking (`#{?mouse_any_flag,…}`).
- R2. When the pane is not on the alternate screen and no app has asserted mouse capture, wheel events enter one-shot `copy-mode -e`; exit is automatic when the user reaches the live tail.
- R3. When the pane is on the alternate screen and no app has asserted mouse capture (the precise case that produced `not in a mode` historically), wheel events do not enter copy-mode; behavior is a `send-keys -M` no-cost fallback rather than dropping the event.
- R4. `history-limit` is raised from `0` to `50000`, set via the generated `-f` config so the initial pane allocates with the buffer (tmux/tmux#4705).
- R5. The four-item allowlist (`MouseDrag1Border`, `MouseDown1Pane`, `M-Left`, `M-Right`) is preserved. Only the wheel-binding nuke is reversed.
- R6. `prefix None` and the `unbind-key -a` lockdown across `prefix`, `copy-mode`, and `copy-mode-vi` tables are preserved. Copy-mode entry is reachable only via the smart-wheel rule from R2.

**Right pane — Claude Code and Codex env defaults**

- R7. Codex interactive default includes `--no-alt-screen` (Codex v0.81.0-alpha.1+, already covered by the pinned `MIN_CODEX_VERSION = 0.118.0`).
- R8. Claude Code default does NOT force `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`.
- R9. Users can opt in to tmux-level scrollback under Claude Code by exporting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` in their shell; orch documents this knob.

**Left pane — Ink scrollable viewport**

- R10. The Ink steps-view supports keyboard-driven scroll: arrow keys, `j`/`k`, PageUp/PageDown, Home (jump to top), End (jump to bottom and resume live tail).
- R11. When step events arrive while the user is scrolled away from the bottom, the viewport stays put. Live tail resumes only when the user explicitly jumps to End.
- R12. A visible indicator distinguishes "scrolled" from "live tail" — rendered in the existing `<ViewModeFooter>` slot.
- R13. Mouse wheel is not bound to any scroll action on the left pane (Ink redraws the whole canvas — tmux scrollback would be deceptive).

**Discoverability**

- R14. Startup banner / `status-right` text is revised to point users at in-pane scroll first; `logs --latest --follow` stays as the power-user fallback.
- R15. `docs/getting-started.md` documents the smart-wheel right-pane behavior, the Claude Code env-var opt-in, the Codex `--no-alt-screen` default, and the left-pane key map.

**Origin acceptance examples:** AE1 (covers R1, R3), AE2 (covers R2), AE3 (covers R11), AE4 (covers R12), AE5 (covers R7), AE6 (covers R8, R9).

---

## Scope Boundaries

- Side-channel pager pane (`less -R +F <tee>` swap-in) — deferred per origin.
- Orch-owned fullscreen Ink transcript view with search / step-jumps / copy-to-clipboard — deferred per origin.
- PTY recording (`script -f`, asciinema) of interactive runners — out of scope per origin.
- Upstream Claude Code / Codex mouse-capture fixes — origin scope boundary preserved.
- Re-introducing arbitrary tmux prefix bindings, repopulating `copy-mode`, or relaxing any other element of the strict-sandbox lockdown — out of scope per origin. Only the wheel-binding nuke and `history-limit 0` are reversed.
- iTerm2 `tmux -CC` integration — not supported per origin; users wanting this combination disable CC's alt-screen via R9's env var.

### Deferred to Follow-Up Work

- **Promote "user intent over auto-jumping" to a CLAUDE.md / `docs/testing-strategy.md` norm.** Flagged by learnings research as worth doing once two plans invoke the rule; orthogonal to this plan's feature scope.
- **Update `docs/references/tmux-commands.md` with the new wheel binding shape.** The reference is currently silent on `bind-key` for wheel events; the canonical pattern lands here, but the reference update is a follow-up.
- **Raise the `tail -n 5000` first-view backfill in `src/hosts/two-pane/pane-map/right-pane-controller.ts:268`.** Independent knob from `history-limit`; only revisit if U1 validation shows visible scrollback feels truncated despite the 50k tmux buffer.
- **Bump `MIN_CODEX_VERSION` to gate `--no-alt-screen` explicitly.** Today's pin (0.118.0) is already well above the flag floor (0.81.0-alpha.1); a tighter gate is cosmetic and can be added when the next minimum changes for an unrelated reason.

---

## Context & Research

### Relevant Code and Patterns

- `src/services/tmux/session-init.ts` — appliance `-f` config builder. `APPLIANCE_CONFIG_LINES` (:125-146), `STATUS_RIGHT_HINT` (:58), `ALLOWLIST` (:42-47), `TABLES_TO_WIPE` (:54), call ordering in `initOrchSession` (:84-123). All-keytable wipe runs BEFORE the allowlist bind loop — so any new wheel binding must live in `ALLOWLIST`, not in the `-f` config (where it would be wiped).
- `src/services/tmux/tmux-service.ts:369-385` — `BindKeyOptions.command: readonly string[]`. Each element is a token passed verbatim to `tmux bind-key`; no shell, no `--` separator (per `docs/plans/2026-05-05-feat-tmux-strict-appliance-mode-plan-v2.md` AD-1).
- `src/cli/detect-tmux.ts:10-11` — `MIN_TMUX_MAJOR=3`, `MIN_TMUX_MINOR=2`. Probe at `:38-69`, satisfaction check at `:71-75`. Used by `src/cli/main.ts:269`.
- `src/runners/codex/codex-runner.ts:216-228` — `buildInteractiveArgv`. Existing flag order is `['codex', '--full-auto'|'--sandbox <m>', '-m <model>?', ...flags, ...extraArgs, '--', prompt]`. Resume command at `:359-365`. Version preflight (`MIN_CODEX_VERSION='0.118.0'`) at `:146`, gated at `:295-298`.
- `src/hosts/two-pane/steps-view/step-types.ts:109-121` — `StepsViewState` discriminated union; carries `view: ViewMode`, optional `banner?: Banner`. `ViewMode = {mode:'live'} | {mode:'replay', stepName}` (`:92-94`).
- `src/hosts/two-pane/steps-view/project-steps-view.ts:33-80` — pure projector folding `RunState` + `LiveOverlay` + `TuiOverlay` into `StepsViewState`. New scroll field threads through here.
- `src/hosts/two-pane/steps-view/steps-view.tsx:93-152` — `useInput` hook with existing keymap (`Esc`, ArrowUp/Down for selection, Enter, `f`/`F`, `q`/Ctrl-C, `?`). `<ViewModeFooter>` at `:342-358`. Diagnostic key IPC writes to `tui-keys.ndjson` via `classifyKey` (`:378-388`).
- `src/hosts/two-pane/steps-view/steps-view-hooks.ts:49-88` — `useStepsSelection` shape; sibling `useStepsScroll` will mirror this pattern.
- `src/services/process/merge-env.ts` — `mergeEnv(processEnv, extras, ctxEnv)`. Three-layer precedence per `docs/plans/2026-04-27-feat-env-passthrough-plan.md`. (Note: CLAUDE.md cites `src/runners/_shared/merge-env.ts`; actual path is under `src/services/process/`. Plan respects current path.)
- `src/cli/main.ts:300-322` — `buildBanner`, `buildTwoPaneLogsHint`. R14 updates land here plus `STATUS_RIGHT_HINT`.
- `tests/helpers/real-tmux/` — Tier-1 harness. `createRealTmuxFixture`, `PaneHandle.capture()`/`captureRaw()`, `mountTmuxHost({disableStepsView: true})`. Skip guards `canRunRealTmux()` / `canRunRealTmuxE2E()`.

### Institutional Learnings

- `docs/plans/2026-05-05-feat-tmux-strict-appliance-mode-plan-v2.md` (the directly-amended plan). AD-2 fixes the required argv ordering (`-f config → unbind → bind`); AD-3 establishes `history-limit` must be in the `-f` config (not a post-create `setOption`) because the initial pane locks its grid at allocation; AD-9 keeps `status-right` as the discoverability surface. The current plan reverses AD-9's wheel no-op and AD-3's value of `0`, preserving every other invariant.
- `docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md` — explicitly anticipated this revisit ("Smart wheel forwarding. Revisit if/when Claude Code and Codex ship usable wheel-in-tmux behavior"). Asymmetric default (Codex flag on, CC env var off) honors the brainstorm's caution about partially-fixed-upstream surfaces.
- `docs/plans/2026-04-27-feat-env-passthrough-plan.md` — `mergeEnv` policy. R9 is a `processEnv`-passthrough case, NOT an `extras` injection (the latter would re-introduce the env-allowlist anti-pattern this plan retired). R8 is "no change" under passthrough; workflow authors who want per-step override use `ctx.env`.
- `docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md` U4 — established `view: ViewMode` and `banner: Banner` on `StepsViewState`, plus the "user intent over auto-jumping" rule and the `<ViewModeFooter>` rendering pattern. R10–R12 extend this seam rather than introducing a parallel indicator.
- `docs/plans/2026-05-01-feat-codex-runner-parity-plan.md` — Codex flag matrix already audited `--no-alt-screen` as interactive-only. R7 adds it as a default in the existing `buildInteractiveArgv` slot; autonomous `codex exec` is untouched.
- `docs/plans/2026-05-12-001-feat-steps-view-visual-polish-plan.md` — Ink color/border conventions (cyan selection, gray hairlines; `chalk.level=3` test preamble; `renderToString` + `stripAnsi` pattern). The R12 indicator follows these.
- `docs/findings/2026-05-20-behavioral-batch-findings.md` F-3, F-4, T-1; `docs/handovers/2026-05-20-q-and-ctrl-c-mid-step-handover.md` — `useInput` precedent and the `isUserDriven` gating pattern. Scroll-state lives local to the Ink renderer; intents only project outward when the user crosses a meaningful boundary (e.g., End → resume live tail → emit `follow-live`).
- `docs/solutions/autonomous-transcript-rendering.md` (2026-05-11 addendum) — confirms the right pane consumes bytes via `tail -n 5000 -F <tee>` from a hidden source pane. `history-limit` bump and the `tail -n` first-view bound are independent knobs that compose; only the former is in scope here.

### External References

- tmux/tmux#3705 — the `mouse_any_flag` + `alternate_on` format-string composition that the smart-wheel rule uses.
- tmux/tmux#4705 — `set -g history-limit` must be present at pane allocation time; setting it later does not resize existing panes' grids.
- openai/codex#8555 — Codex `--no-alt-screen` ships in v0.81.0-alpha.1.
- Claude Code fullscreen docs (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`) and CC's `Ctrl+O` then `[` transcript-dump — Claude Code's own scroll path that orch users get for free under R8.

---

## Key Technical Decisions

- **Smart-wheel binding lands inside the existing `ALLOWLIST`, not in the `-f` config file.** The `unbind-key -a -T root` step runs after config-write and would wipe any `bind-key` written in the config. Extending the allowlist from four to six entries preserves the established invariant ordering (config write → createSession → unbind → bind).
- **`history-limit` value is `50000`.** Origin's "~50,000" pinned; learnings research confirms this composes with the `tail -n 5000` first-view bound (the latter only affects hidden-pane backfill on swap-in, not live-pane scrollback).
- **tmux floor bumps to 3.3** (`MIN_TMUX_MINOR = 3`) for the `mouse_any_flag` format string introduced in tmux 3.3.
- **Codex `--no-alt-screen` is an argv decision, not an env decision** (per parity-plan flag matrix). Lands in `buildInteractiveArgv` and (mirrored) `resumeCommand`. Autonomous (`codex exec`) is untouched. No `MIN_CODEX_VERSION` bump (0.118.0 ≫ 0.81.0-alpha.1).
- **Claude Code is not modified in code.** R9 is delivered by the existing `processEnv` → `mergeEnv` passthrough: users export `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, it reaches the runner without a runner-side `extras` entry. Adding it to `extras` would re-introduce the env-allowlist anti-pattern explicitly retired by the env-passthrough plan.
- **Left-pane scroll state is `scrollOffset: number` on `StepsViewStateBase`, NOT a new `{mode:'scrolled'}` variant on `ViewMode`.** Scroll composes orthogonally with `view.mode = 'live' | 'replay'`; adding a third variant forces every footer/projector branch to handle four states. The derived predicate `atLiveTail = scrollOffset === 0` is what the footer renders on.
- **The R12 indicator is a hint appended to the existing `<ViewModeFooter>` string, not a new chrome row or banner.** Matches the visual-polish plan's color palette (dim gray hairlines, semantic colors reserved for status). Footer-text-only treatment keeps the indicator visible without consuming a row from the visible step slice.
- **End key both resets `scrollOffset` to 0 and emits a `follow-live` intent** so the right pane re-pins to live if the user was in replay. Mirrors the existing `f` key precedent.
- **The new `not in a mode` regression test lives at Tier 1 (real-tmux + a tiny alt-screen-asserting FakeRunner).** Tier 4 (real Claude/Codex) is unnecessary — tmux's wheel response is what's under test, not agent behavior. Wheel-event injection mechanism is an explicit open question for implementation.

---

## Open Questions

### Resolved During Planning

- **Codex version detection (origin R7 deferred-to-planning):** Resolved. `MIN_CODEX_VERSION = '0.118.0'` is already pinned and probed once-per-runner via `checkCodexVersion`. 0.118.0 is well above 0.81.0-alpha.1 — `--no-alt-screen` is always available. No graceful-fallback path required.
- **Left-pane viewport state shape (origin R10/R12 deferred-to-planning):** Resolved. `scrollOffset: number` on `StepsViewStateBase` (rows from the bottom; 0 = live tail). `atLiveTail` is derived, not stored. Visible-slice computation derives from `terminalHeight - chromeHeight` and `scrollOffset` at render time.
- **`mergeEnv` path discrepancy:** CLAUDE.md cites `src/runners/_shared/merge-env.ts`; actual path is `src/services/process/merge-env.ts`. Plan uses the actual path. (CLAUDE.md correction is a separate doc fix, not part of this plan.)

### Deferred to Implementation

- **Exact `if-shell -F` argv tokenization for the smart-wheel `bindKey` call.** The `BindKeyOptions.command: readonly string[]` adapter passes tokens verbatim to `tmux bind-key`; whether tmux accepts `['if-shell', '-F', '#{?…}', 'send-keys -M', 'copy-mode -e']` as five separate tokens — or needs the inner sub-commands as single quoted strings — is faster to verify against a real tmux fixture than to predict. U2 resolves this empirically with the real-tmux harness.
- **`copy-mode -e` exit semantics on fast wheel-up/wheel-down sequences (origin R2 deferred):** Whether one-shot exits on every wheel-down or only at the buffer's bottom is tmux-version-dependent. Validated under U2's Tier-1 test by sending rapid wheel events and asserting on `#{pane_in_mode}` evolution.
- **`send-keys -M` no-op behavior in alt-screen-without-mouse-capture (origin R3 deferred):** Whether the unconditional `send-keys -M` actually produces no observable effect — or leaks a spurious mouse byte into the agent — is verified under U2. If observed, the R3 branch falls back to unconditional swallow.
- **Wheel-event injection in the Tier-1 harness.** `tmux send-keys WheelUpPane` may not be the right mechanism (named-key set in the harness does not include wheel events today). U2's first investigative step is identifying the actual injection primitive — likely a direct `tmux send-keys -X scroll-up` call exercised under the bindings, or a synthetic mouse-protocol byte stream.
- **Final R14 status-right and banner copy.** Strings need to fit ~40 chars (status-right) and read naturally in `[orch] mode=two-pane …` (banner). Picked at write-time during U4 from two or three candidates.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Smart-wheel decision tree (right pane):**

```text
WheelUpPane / WheelDownPane (root keytable, via if-shell -F):

  mouse_any_flag?               -- the app has asserted mouse tracking
    yes  -> send-keys -M        (forward; agent owns the wheel)
    no   -> alternate_on?       -- the app is on the alt-screen but did NOT capture mouse
              yes  -> send-keys -M    (no-cost fallback, swallows safely; do NOT enter copy-mode)
              no   -> copy-mode -e    (one-shot; exit at live tail)
```

Behavior matrix:

| Pane state                              | Wheel up                    | Wheel down                  |
|-----------------------------------------|-----------------------------|-----------------------------|
| Alt-screen + mouse captured (CC, Codex `--alt-screen`) | `send-keys -M` → agent       | `send-keys -M` → agent       |
| Alt-screen + no mouse capture (alt-screen TUI without mouse) | `send-keys -M` (no-op)       | `send-keys -M` (no-op)       |
| No alt-screen, no mouse capture (file-tail, Codex `--no-alt-screen`) | `copy-mode -e` (enter scroll) | `copy-mode -e` (exit at tail) |

**Steps-view state extension (left pane):**

```text
StepsViewStateBase {
  run, steps, view, banner?
  scrollOffset: number            // rows from bottom; 0 == at live tail
}

derived: atLiveTail = (scrollOffset === 0)

useStepsScroll(visibleCount, totalCount) {
  scrollOffset
  scrollUp / scrollDown    (one row)
  pageUp   / pageDown      (visibleCount rows)
  jumpTop                  (clamped to max scrollOffset)
  jumpBottom               (scrollOffset := 0, emit follow-live intent)
}

footer rendering:
  atLiveTail            -> existing string  ('▶ live · …' / '⏸ viewing … · …')
  !atLiveTail           -> existing string + ' · ↑ scrolled · End live'
```

---

## Implementation Units

### U1. Raise tmux `history-limit` and bump tmux version floor

**Goal:** Switch the appliance config from `history-limit 0` to `50000`, and bump the supported tmux floor to 3.3 so the smart-wheel format strings in U2 are runnable.

**Requirements:** R4 (and prerequisite for R1/R2/R3 via the 3.3 floor).

**Dependencies:** None.

**Files:**
- Modify: `src/services/tmux/session-init.ts` (replace `set -g history-limit 0` at the existing line in `APPLIANCE_CONFIG_LINES`)
- Modify: `src/cli/detect-tmux.ts` (`MIN_TMUX_MINOR: 2 -> 3`)
- Modify: `tests/unit/services/tmux/session-init.test.ts` (history-limit substring assertion)
- Modify: `tests/integration/services/tmux/tmux-real.integration.test.ts` (`#{history_size}` assertions on initial pane and split pane)
- Modify: `tests/unit/cli/detect-tmux.test.ts` if it pins the version floor

**Approach:**
- One-line constant change in `APPLIANCE_CONFIG_LINES`. Keep the existing rationale comment explaining why the option lives in the `-f` config (pane-creation capture, tmux/tmux#4705).
- One-line constant change in `detect-tmux.ts`; rely on the existing probe + satisfaction check.
- Test assertions move from "equals 0" to ">= 50000" — keep the predicate shape; don't pin to exactly 50000 in case future tuning bumps it.

**Patterns to follow:**
- Existing `APPLIANCE_CONFIG_LINES` string shape (`set -g <option> <value>`) at `src/services/tmux/session-init.ts:125-146`.
- Existing `meetsMinimumTmuxVersion` callsite in `src/cli/main.ts:269`.

**Test scenarios:**
- Happy path: after `initOrchSession`, `tmux display-message -p '#{history_size}'` on the initial pane returns a value ≥ 50000.
- Happy path: on a freshly split pane after a 200-line stream, `#{history_size}` again returns ≥ 50000 (validates origin Dependencies note about tmux/tmux#4705 applying uniformly).
- Edge case: with tmux 3.2 on PATH, `meetsMinimumTmuxVersion` returns false and the CLI surfaces a clear error before init runs.
- Integration: unit-level `session-init` ordering test still passes (config write happens before unbind; bind happens after) — assertion list adjusted only for the new history-limit value.

**Verification:** Strict-sandbox ordering test passes with the new value; real-tmux integration test confirms ≥ 50000 on both initial and split panes; `detect-tmux` correctly rejects tmux 3.2.

---

### U2. Smart-wheel binding (forward / one-shot copy-mode / swallow)

**Goal:** Reintroduce wheel events under the smart-wheel rule (R1/R2/R3) while preserving every other strict-sandbox invariant (R5, R6). Land the `not in a mode` regression test that the strict-sandbox plan deferred.

**Requirements:** R1, R2, R3, R5, R6. Covers AE1, AE2.

**Dependencies:** U1 (tmux 3.3 floor required for `mouse_any_flag`).

**Files:**
- Modify: `src/services/tmux/session-init.ts` (extend `ALLOWLIST` with two new entries for `WheelUpPane` and `WheelDownPane`)
- Possibly modify: `src/services/tmux/real-tmux-service.ts` if `bindKey` tokenization for `if-shell` requires adapter touchups
- Modify: `tests/unit/services/tmux/session-init.test.ts` (bind count: 4 → 6; ordering)
- Modify: `tests/integration/services/tmux/tmux-real.integration.test.ts` (`list-keys -T root` expectation; copy-mode and copy-mode-vi tables remain empty)
- Create: `tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts`

**Approach:**
- Add two entries to `ALLOWLIST`: one for `WheelUpPane`, one for `WheelDownPane`, each with a `command` argv that expresses the `if-shell -F` smart-wheel rule from High-Level Technical Design.
- Tokenization for `if-shell` is unresolved at planning time and resolved empirically in this unit (see Open Questions / Deferred to Implementation). First investigative step: hand-run `tmux bind-key -T root WheelUpPane if-shell -F "#{?mouse_any_flag,1,…}" "send-keys -M" "copy-mode -e"` against a scratch tmux server to determine the correct token boundaries, then encode that shape into the `command` array.
- New regression test stands up a `createRealTmuxFixture`, mounts the host with `disableStepsView: true`, drives a fake-runner that emits the alt-screen + SGR mouse asserting prelude (`\x1b[?1049h\x1b[?1006h`), sends wheel events, and asserts `'not in a mode'` is absent from `right.capture()`.
- Repeat the same shape across the four cells of the smart-wheel matrix (alt-screen × mouse / alt-screen × no-mouse / no-alt × no-mouse / no-alt × mouse), expressed as separate `it(...)` blocks.

**Execution note:** Characterize tmux's `bind-key` + `if-shell` argument parsing against a real tmux server *before* committing the `command` token shape in `ALLOWLIST`. Pinning the wrong tokenization in code produces a silent regression of the original `not in a mode` bug.

**Technical design:**

The `if-shell` conditional is built from the existing `mouse_any_flag` and `alternate_on` tmux format strings:

```text
bind-key -T root WheelUpPane    if-shell -F "#{?mouse_any_flag,1,0}" "send-keys -M" "if-shell -F \"#{?alternate_on,1,0}\" \"send-keys -M\" \"copy-mode -e\""
bind-key -T root WheelDownPane  if-shell -F "#{?mouse_any_flag,1,0}" "send-keys -M" "if-shell -F \"#{?alternate_on,1,0}\" \"send-keys -M\" \"send-keys -M\""
```

(Directional shape only — actual token boundaries discovered against real tmux in U2.)

**Patterns to follow:**
- Existing `ALLOWLIST` entries at `src/services/tmux/session-init.ts:42-47`.
- `BindKeyOptions.command: readonly string[]` contract at `src/services/tmux/tmux-service.ts:369-385`.
- The unit-level `session-init` ordering test at `tests/unit/services/tmux/session-init.test.ts:85-115`.

**Test scenarios:**
- **Covers AE1.** Happy path: with a fake-runner that asserts `\x1b[?1049h\x1b[?1006h` (alt-screen + SGR mouse), sending wheel-up does not produce `not in a mode` text. Captured via `right.capture()`.
- **Covers AE2.** Happy path: with a fake-runner that emits 200 lines into a no-alt-screen pane, wheel-up enters copy-mode (`#{pane_in_mode}` becomes `1`), prior lines are visible in the capture, and wheel-down at the buffer bottom transitions back to live (`#{pane_in_mode}` returns to `0`).
- Edge case: alt-screen-without-mouse-capture cell — wheel events do not enter copy-mode and do not produce `not in a mode`. If the `send-keys -M` no-op leaks a visible mouse-protocol byte into the agent, fall back to the unconditional swallow branch (resolves the origin R3 deferred question in code).
- Edge case: rapid alternating wheel-up/wheel-down sequence — `#{pane_in_mode}` evolution is observable and never gets stuck. Resolves the origin R2 deferred question empirically.
- Integration: `list-keys -T copy-mode` and `list-keys -T copy-mode-vi` report empty after init (R6 invariant preserved despite reintroducing wheel access to copy-mode).
- Integration: `list-keys -T root` reports exactly six bindings — the original four plus `WheelUpPane` and `WheelDownPane`.
- Integration: `prefix None` remains set after init.

**Verification:** All four cells of the smart-wheel matrix exhibit the expected behavior; copy-mode tables stay empty; the strict-sandbox ordering test still passes with the bind-count expectation updated from 4 to 6.

---

### U3. Codex `--no-alt-screen` default for interactive mode

**Goal:** Insert `--no-alt-screen` into Codex's interactive argv (and the matching `resume` argv) so users get a flat-buffer Codex that composes with U2's smart-wheel copy-mode entry.

**Requirements:** R7. Covers AE5.

**Dependencies:** None (independent of U1/U2; useful only after U2 lands but can ship in any order without correctness risk — the flag is harmless without the smart-wheel rule).

**Files:**
- Modify: `src/runners/codex/codex-runner.ts:216-228` (`buildInteractiveArgv`)
- Modify: `src/runners/codex/codex-runner.ts:359-365` (resume command)
- Modify: `tests/unit/runners/codex/codex-runner.test.ts` (argv expectations)
- Possibly modify: `tests/integration/runners/codex/codex-runner.integration.test.ts` if it asserts argv

**Approach:**
- Add `--no-alt-screen` to the argv immediately after the `--full-auto` / `--sandbox` segment and before the user-supplied `flags`/`extraArgs`. In `resumeCommand`, the top-level flag must precede the `sessionId` positional, so insert it between `'resume'` and `sessionId` — yielding `['codex', 'resume', '--no-alt-screen', sessionId, ...flags, ...extraArgs]`.
- Autonomous `codex exec` path is untouched (per parity-plan flag matrix — interactive-only flag).
- User-supplied `flags: ['--no-alt-screen']` is idempotent (Codex accepts the repeated flag; verify in the unit test).
- No `MIN_CODEX_VERSION` bump (already 0.118.0, well above the 0.81.0-alpha.1 floor).

**Patterns to follow:**
- Existing flag-ordering convention in `buildInteractiveArgv` (sandbox/auto → model → flags → extraArgs → `--` → prompt).
- `assertFlagAllowed` denylist mechanism at `src/runners/codex/codex-runner.ts:71-77` — `--no-alt-screen` is not denied and does not need to be.

**Test scenarios:**
- Happy path: interactive-mode argv contains `--no-alt-screen` in the expected position relative to sandbox flag and model flag.
- Happy path: autonomous-mode argv (built via `buildAutonomousArgv`) does NOT contain `--no-alt-screen`.
- Happy path: resume-mode argv contains `--no-alt-screen`.
- Edge case: user-supplied `flags: ['--no-alt-screen']` appears twice in the final argv; Codex accepts it as idempotent (validate against the Tier-4 real-Codex integration test, env-gated).
- Edge case: user-supplied `flags: []` and `extraArgs: []` produce an argv where `--no-alt-screen` is still present in the expected position.
- **Covers AE5.** Integration (Tier 4, env-gated `RUN_REAL_CODEX_E2E=1`): real Codex launched in two-pane right pane runs without alt-screen — visible scrollback survives between turns. This test depends on U2's smart-wheel rule to actually exercise the scrollback path; document the dependency in the test file.

**Verification:** Argv tests pass; existing `MIN_CODEX_VERSION` preflight is untouched; Tier-4 verification (when run) shows visible scrollback after a Codex turn.

---

### U4. Status-right and banner copy revision

**Goal:** Update discoverability strings to point users at in-pane scroll first; keep `logs --latest --follow` as a power-user fallback.

**Requirements:** R14.

**Dependencies:** U1 (the "you can scroll" copy is only honest after history-limit > 0).

**Files:**
- Modify: `src/services/tmux/session-init.ts:58` (`STATUS_RIGHT_HINT`)
- Modify: `src/cli/main.ts:300-322` (`buildBanner`, `buildTwoPaneLogsHint`)
- Modify: `tests/unit/cli/banner.test.ts:20-44`
- Modify: `tests/unit/services/tmux/session-init.test.ts:133` (status-right substring assertion)
- Modify: `tests/integration/services/tmux/tmux-real.integration.test.ts` (status-right grep)

**Approach:**
- Pick a `STATUS_RIGHT_HINT` string under ~40 chars that names the new wheel behavior (e.g., `wheel: scroll · keys: arrows j/k PgUp/PgDn`). Exact copy decided at write-time; two-three candidates floated in code review.
- Refresh `buildTwoPaneLogsHint` to mention in-pane scroll first and `logs --latest --follow` as the power-user follow-on.
- Keep `buildBanner`'s `[orch] mode=two-pane (…)` shape; only the trailing-hint copy changes.

**Patterns to follow:**
- Existing string shapes in `STATUS_RIGHT_HINT` and `buildTwoPaneLogsHint`.

**Test scenarios:**
- Happy path: `STATUS_RIGHT_HINT` substring matches the new constant in `session-init` config emission.
- Happy path: `buildBanner` output contains the new hint substring (or unchanged shell — depending on whether banner carries the hint).
- Happy path: `buildTwoPaneLogsHint` still emits the `logs --latest --follow` substring (power-user fallback preserved).
- Edge case: `--no-attach` mode still emits the logs hint (users without two-pane attach need the fallback to be discoverable).

**Verification:** All copy assertions updated; visual sanity check at 80-col status-right shows no wrap.

---

### U5. Ink steps-view scrollable viewport with live-tail indicator

**Goal:** Add keyboard-driven scroll inside the steps-view, a derived "scrolled vs live tail" indicator on the existing footer, and the no-auto-scroll-to-tail behavior on new step events.

**Requirements:** R10, R11, R12, R13. Covers AE3, AE4.

**Dependencies:** None (orthogonal to tmux work).

**Files:**
- Modify: `src/hosts/two-pane/steps-view/step-types.ts` (add `scrollOffset: number` to `StepsViewStateBase`)
- Modify: `src/hosts/two-pane/steps-view/project-steps-view.ts` (default `scrollOffset: 0` in projection)
- Modify: `src/hosts/two-pane/steps-view/steps-view-model.ts` (preserve scroll offset across state emissions; the projection is recomputed on each event, so the offset must be threaded via the model layer, not derived from the projector alone)
- Modify: `src/hosts/two-pane/steps-view/steps-view-hooks.ts` (add `useStepsScroll` hook)
- Modify: `src/hosts/two-pane/steps-view/steps-view.tsx` (wire scroll keys in `useInput`; compute visible slice from `scrollOffset`; extend `<ViewModeFooter>` with the scrolled hint)
- Modify: `classifyKey` enum tag set at `src/hosts/two-pane/steps-view/steps-view.tsx:378-388` (add tags for the new keys so the `tui-keys.ndjson` audit trail covers them)
- Create: `tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx`
- Modify: `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx` (existing footer-text assertions may need updates)

**Approach:**
- `scrollOffset` is a rows-from-bottom counter (0 = at live tail). The visible slice in `<StepsView>` is `state.steps.slice(start, end)` where `end = state.steps.length - scrollOffset` and `start = Math.max(0, end - visibleCount)`. Clamp `scrollOffset` to `[0, max(0, steps.length - visibleCount)]` at read time so a step disappearing from underneath the user does not produce an invalid slice.
- `useStepsScroll(visibleCount, totalCount)` exposes `scrollUp` / `scrollDown` (1 row), `pageUp` / `pageDown` (visibleCount rows), `jumpTop` (max offset), `jumpBottom` (offset := 0, emits `follow-live` intent). Hook keeps the offset in `useRef` so re-renders triggered by model events do not reset it.
- `useInput` adds: `j` / ArrowDown → `scrollDown`; `k` / ArrowUp → `scrollUp`; PageDown → `pageDown`; PageUp → `pageUp`; Home (or `g`) → `jumpTop`; End (or `G`) → `jumpBottom`. Selection movement and scroll movement need to coexist — current ArrowUp/Down are bound to `moveUp` / `moveDown` (selection). Resolution: ArrowUp/Down moves selection AND scrolls when the selection cursor would leave the visible window; PageUp/PageDown and Home/End are pure scroll without touching selection. (Alternative resolved during implementation: ArrowUp/Down moves selection only; scroll keys are j/k/PgUp/PgDn/Home/End. Pick the lower-surprise option after a usability check.)
- Footer extension: when `scrollOffset > 0`, append ` · ↑ scrolled · End live` to the existing `<ViewModeFooter>` text. When `scrollOffset === 0`, footer is unchanged.
- Mouse wheel is not bound on the left pane: under Ink's `alternateScreen: true`, wheel events never reach `useInput`. No tmux-side unbind work is needed because the appliance lockdown already covers the left pane (only the right pane gets the smart-wheel binding from U2 — the binding is scoped via the pane the wheel event lands in).

**Execution note:** Write Tier-2 `ink-testing-library` tests first for scroll-key intents and footer-string projection, then wire the implementation. Mirrors the established steps-view test pattern (`renderToString` + `stripAnsi`, `chalk.level = 3` preamble).

**Technical design:**

```text
StepsViewStateBase: { run, steps, view, banner?, scrollOffset: number }

visible slice:
  end   = steps.length - clampedScrollOffset
  start = max(0, end - visibleCount)
  visibleSteps = steps.slice(start, end)

footer derivation:
  base = view.mode === 'live'   ? '▶ live · ⏎ view step · q quit · ? help'
       : view.mode === 'replay' ? '⏸ viewing <stepName> · f live · ⏎ view another · q quit · ? help'
       : base
  scrolled = scrollOffset > 0
  output = scrolled ? base + ' · ↑ scrolled · End live' : base
```

**Patterns to follow:**
- `useStepsSelection` hook shape at `src/hosts/two-pane/steps-view/steps-view-hooks.ts:49-88`.
- `useInput` precedent at `src/hosts/two-pane/steps-view/steps-view.tsx:93-152`.
- `<ViewModeFooter>` rendering at `src/hosts/two-pane/steps-view/steps-view.tsx:342-358`.
- `chalk.level = 3` test preamble (per `docs/plans/2026-05-12-001-feat-steps-view-visual-polish-plan.md` KD7).
- `classifyKey` enum extension pattern (existing tags at `steps-view.tsx:378-388`).

**Test scenarios:**
- **Covers AE3.** Happy path: with `scrollOffset = 5` and a new `step:start` event arriving, the rendered output's `start`/`end` indices do not change. Verified via `renderToString` snapshot + visible-step-name extraction.
- **Covers AE4.** Happy path: when `scrollOffset > 0`, footer string contains `↑ scrolled · End live`. When `scrollOffset === 0`, footer string is the standard `▶ live · …` or `⏸ viewing … · …`.
- Happy path: `k` / ArrowUp decrements selection (or increments `scrollOffset`, depending on the coexistence resolution); `j` / ArrowDown is the inverse. Both produce a `classifyKey` tag entry in `tui-keys.ndjson`.
- Happy path: PageUp / PageDown move `scrollOffset` by `visibleCount`.
- Happy path: Home (or `g`) jumps to top (clamps to `steps.length - visibleCount`); End (or `G`) sets `scrollOffset` to 0 AND emits the `follow-live` intent.
- Edge case: `steps.length <= visibleCount` — scroll keys are no-ops; `scrollOffset` stays at 0.
- Edge case: a step is removed (run cleanup or retroactive replay re-emission); `scrollOffset` clamps so the visible slice remains valid; the footer indicator updates if the clamp moves scrollOffset to 0.
- Edge case: mouse wheel on the left pane — no `classifyKey` tag is written; no `useInput` callback fires; no scroll-offset change.
- Edge case: the user is in replay (`view.mode === 'replay'`) AND scrolled; both the replay footer text and the scrolled indicator are present; pressing End emits `follow-live` AND should the right pane swap back to live (existing follow-live semantics).
- Integration: `tui-keys.ndjson` contains entries for the new keys with the new `classifyKey` tags.

**Verification:** AE3 reproduces under `ink-testing-library` (step event does not move viewport); AE4 reproduces (footer shows scrolled indicator when offset > 0); key audit trail includes new tags; the existing selection behavior (cyan `▌` cursor) still gated on `isUserDriven`.

---

### U6. Documentation update

**Goal:** Update user-facing documentation for the new wheel behavior, the Claude Code env-var opt-in, the Codex `--no-alt-screen` default, and the left-pane key map. Documents R8/R9 (which are doc-only) and discharges R15.

**Requirements:** R8, R9, R15.

**Dependencies:** U1–U5 landed (so docs describe actual behavior, not aspirational behavior).

**Files:**
- Modify: `docs/getting-started.md` — sections at the "Appliance mode (two-pane only)" heading (replaces the "Mouse-wheel scrolling is disabled" sentence and updates the four-interaction lockdown table); "The Steps TUI (two-pane left pane)" heading (adds j/k/PgUp/PgDn/Home/End to the existing `↑/↓/⏎/f/q` keymap); "A detail worth knowing" (consistency check — left-pane Ink alt-screen explanation stays accurate)
- Modify: `docs/getting-started.md` — add a new short subsection (or extend an existing one) on Claude Code env-var opt-in and Codex `--no-alt-screen` default
- Possibly modify: `docs/logging.md` (cross-link the in-pane scroll behavior so the `logs --latest --follow` doc points back at the new primary)

**Approach:**
- The "Mouse-wheel scrolling is disabled" sentence is replaced with a description of the smart-wheel rule (alt-screen + mouse → forwarded; no alt-screen → tmux copy-mode; alt-screen + no mouse → safe no-op).
- The four-interaction table grows by two rows (or is replaced with a friendlier prose paragraph + table).
- The Steps TUI keymap section adds the new keys.
- A new paragraph on Claude Code env-var opt-in: what `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` does, why orch doesn't set it by default, and how to set it in the user's shell.
- A new paragraph on Codex `--no-alt-screen` default: what it does, how to override via workflow `flags`, what it doesn't do (it doesn't change how Codex handles its own `Ctrl+T` pager).

**Patterns to follow:**
- Existing tone in `docs/getting-started.md` (terse, code-block heavy where useful).
- Cross-linking style elsewhere in the file.

**Test scenarios:**
- Test expectation: none — doc-only changes; verified by reading and by following the new instructions on a fresh checkout.

**Verification:** Doc reads accurately; all instructions (export the env var, override the Codex flag, use the new key map) succeed on a fresh checkout; the four-interaction lockdown table reflects the post-amendment state.

---

## System-Wide Impact

- **Interaction graph:** New `follow-live` intent emission path from `useStepsScroll.jumpBottom` mirrors the existing `f`-key emission from `steps-view.tsx`. No new IPC channel; existing intent routing through the model layer is unchanged. Smart-wheel binding is scoped to the right pane via the pane the wheel event lands in — the left pane's wheel events stay swallowed by Ink's alt-screen.
- **Error propagation:** The `not in a mode` regression class is structurally guarded by the smart-wheel rule (R3 branch) — the new integration test in U2 freezes that guarantee. Tier-1 fixture failures surface as `'not in a mode'` literal text in `right.capture()`.
- **State lifecycle risks:** `scrollOffset` must be preserved across model state emissions; if the projector recomputes the state object on every event and the model layer discards the prior offset, the viewport will reset on every step event (regression of R11). Mitigation: thread the offset through the model layer (`useRef` in the hook, or as a model-owned field that survives `setState`-triggered re-renders).
- **API surface parity:** Codex resume argv mirrors interactive argv (both gain `--no-alt-screen`); autonomous argv (`codex exec`) stays unchanged. Claude Code argv is unchanged.
- **Integration coverage:** The Tier-1 wheel regression test exercises the four cells of the smart-wheel matrix; the Tier-2 Ink-projection tests exercise scroll-offset preservation across step events. A Tier-4 real-Codex E2E test (env-gated) verifies `--no-alt-screen` default actually produces flat scrollback under real Codex.
- **Unchanged invariants:** `prefix None`, `unbind-key -a` across `prefix`/`copy-mode`/`copy-mode-vi`, the four-item allowlist (`MouseDrag1Border`/`MouseDown1Pane`/`M-Left`/`M-Right`), the `tail -n 5000 -F` first-view backfill in the right-pane controller, the `mergeEnv` three-layer precedence — none change. The plan is narrow on purpose.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Smart-wheel `if-shell -F` tokenization is misencoded — silently fails to dispatch and re-introduces `not in a mode` in some pane state | U2 Execution note: empirical characterization against real tmux *before* committing the `command` token shape; new Tier-1 regression test freezes the behavior across all four matrix cells |
| `send-keys -M` in alt-screen-without-mouse-capture leaks a spurious mouse byte into the agent | U2 edge-case test detects the leak; R3 branch falls back to unconditional swallow if observed |
| Bumping tmux floor to 3.3 breaks environments still on 3.2 | `meetsMinimumTmuxVersion` already surfaces a clear error before init runs (origin Dependencies note); affected users get a single-line upgrade prompt |
| `history-limit 50000` produces measurable tmux memory pressure under long autonomous runs | Origin Key Decisions note: disk logs remain durable source of truth; if measured pressure becomes a problem, the value is tunable (one-line change); follow-up to bump `tail -n 5000` is already in Deferred to Follow-Up Work |
| Codex CLI breaks the `--no-alt-screen` flag in a future version | Existing `MIN_CODEX_VERSION` preflight catches version drift on the lower bound; an upper-bound pin can be added if the flag is removed in a future Codex release (no current signal) |
| `scrollOffset` resets on every step event because the model layer recomputes state and discards the prior offset (R11 regression) | U5 Execution note: write the scroll-offset preservation test first; thread offset through the model layer's `useRef` (or equivalent), validated by AE3's "scroll position unchanged on `step:start`" assertion |
| Selection-movement (ArrowUp/Down) and scroll-movement coexistence is surprising to users | U5 resolution-during-implementation: pick the lower-surprise binding after a quick usability check; document the final shape in U6 |
| Wheel-event injection in the Tier-1 harness turns out to be infeasible with `tmux send-keys` | First investigative step in U2; fallbacks include (a) sending raw mouse-protocol bytes via `send-keys -H` hex, (b) skipping wheel-event injection and exercising the binding via `tmux send-keys -X scroll-up` under the new binding directly, (c) marking the test as Tier-4 only with a manual reproduction note |

---

## Documentation / Operational Notes

- The `docs/references/tmux-commands.md` reference is silent on `bind-key` wheel events; updating it is in Deferred to Follow-Up Work, not part of this plan, but worth picking up immediately after the smart-wheel binding lands.
- No rollout flag or migration. The change is delivered on next merge; users see the new behavior on the next orch run.
- Monitoring: no new dashboards. The `logs --latest --follow` fallback remains and is still the durable view; tmux scrollback is UI convenience only (per origin Key Decisions).

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-21-feat-scrollable-two-pane-requirements.md](../brainstorms/2026-05-21-feat-scrollable-two-pane-requirements.md)
- **Directly amended plan:** [docs/plans/2026-05-05-feat-tmux-strict-appliance-mode-plan-v2.md](2026-05-05-feat-tmux-strict-appliance-mode-plan-v2.md) — AD-1, AD-2, AD-3, AD-9 invariants preserved
- **Brainstorm (strict-sandbox decision):** [docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md](../brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md) — explicit anticipation of this revisit
- **Env policy:** [docs/plans/2026-04-27-feat-env-passthrough-plan.md](2026-04-27-feat-env-passthrough-plan.md) — `mergeEnv` three-layer precedence; R9 is `processEnv` passthrough, not `extras` injection
- **View-mode + banner infrastructure:** [docs/plans/2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md](2026-05-11-001-feat-decouple-live-runner-unified-pane-map-plan.md) U4 — `ViewMode` and `Banner` on `StepsViewState`; "user intent over auto-jumping" rule
- **Codex flag matrix:** [docs/plans/2026-05-01-feat-codex-runner-parity-plan.md](2026-05-01-feat-codex-runner-parity-plan.md) — `--no-alt-screen` interactive-only audit; `MIN_CODEX_VERSION` mechanism
- **Visual conventions:** [docs/plans/2026-05-12-001-feat-steps-view-visual-polish-plan.md](2026-05-12-001-feat-steps-view-visual-polish-plan.md) — color palette, border style, `chalk.level=3` test preamble
- **Testing strategy:** [docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-plan.md](2026-05-12-002-feat-tiered-testing-strategy-two-pane-plan.md); [tests/helpers/real-tmux/README.md](../../tests/helpers/real-tmux/README.md)
- **Right-pane bytes model:** [docs/solutions/autonomous-transcript-rendering.md](../solutions/autonomous-transcript-rendering.md) (2026-05-11 addendum) — `tail -n 5000 -F` first-view backfill
- **Lifecycle findings:** [docs/findings/2026-05-20-behavioral-batch-findings.md](../findings/2026-05-20-behavioral-batch-findings.md) F-3, F-4, T-1; [docs/handovers/2026-05-20-q-and-ctrl-c-mid-step-handover.md](../handovers/2026-05-20-q-and-ctrl-c-mid-step-handover.md)
- **External:** tmux/tmux#3705 (smart-wheel format strings), tmux/tmux#4705 (`history-limit` pane-allocation capture), openai/codex#8555 (Codex `--no-alt-screen`), Claude Code fullscreen docs (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `Ctrl+O` transcript-dump)
