---
date: 2026-05-21
topic: scrollable-two-pane
---

# Scrollable Two-Pane TUI

## Summary

Make both panes of the two-pane TUI scrollable. The right pane gets smart wheel forwarding (gated on `mouse_any_flag` and `alternate_on`), a raised `history-limit`, and a documented env-var opt-in so Claude Code output can flow into native tmux scrollback — with Codex's `--no-alt-screen` enabled by default. The left pane gets a keyboard-driven scrollable viewport implemented inside the Ink steps-view, since tmux scrollback is meaningless for an alt-screen Ink canvas.

---

## Problem Frame

Today the two-pane host runs in strict appliance mode (`docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md`): `history-limit 0` is forced before session creation and every wheel binding is unbound across all key tables. This was a deliberate, narrow fix for a real bug — tmux's default wheel-into-copy-mode bindings produced `not in a mode` errors mid-transcript and froze visible output — but the chosen blast radius removed scroll entirely, with `orch logs --latest --follow` in a second terminal as the only replacement.

That trade-off has become friction in practice:

- During an interactive Claude Code or Codex session, output that scrolls off the visible grid is unreachable without leaving the right pane to a second terminal.
- During an autonomous run, a step that emits hundreds of lines of file-tail output also becomes unscrollable — the same problem, despite no alt-screen and no agent mouse capture being involved.
- The left pane (Ink steps-view on `alternateScreen: true`, see `src/hosts/two-pane/steps-view/steps-view-runner.tsx:160`) is structurally non-scrollable: Ink redraws the whole canvas on every model emission, so tmux scrollback would only ever show the latest frame, never history. To scroll the steps view, scroll has to be a feature of the Ink view itself.

Upstream research (Claude Code fullscreen docs, Codex PR openai/codex#8555, tmux/tmux#3705) shows the right-pane wheel problem is solvable with a `mouse_any_flag` / `alternate_on` conditional and the right env-var posture for the embedded agents. The left-pane problem is in-app Ink work.

---

## Requirements

**Right pane — wheel and scrollback**

- R1. Tmux wheel events in the right pane forward to the running app when the app has asserted mouse tracking (`#{?mouse_any_flag,1,0}` is true). Implementation uses `send-keys -M`.
- R2. When the right pane is not on the alternate screen and no app has asserted mouse capture, wheel events enter one-shot copy-mode (`copy-mode -e`) so the user can scroll native tmux scrollback. Exit returns automatically when the user reaches the live tail.
- R3. When the right pane is on the alternate screen and the app has not asserted mouse capture, wheel events do not enter copy-mode (this is the precise case that produced `not in a mode` historically). Behavior: forward via `send-keys -M` as a no-cost fallback rather than dropping the event.
- R4. `history-limit` is raised from `0` to a bounded value targeting roughly 50,000 lines. The value is set via the generated `-f` config so the initial pane allocates with the buffer (tmux/tmux#4705 still applies).
- R5. The four-item allowlist from the strict-sandbox brainstorm is preserved: drag-to-resize, click-to-focus, `M-Left` / `M-Right` pane switch, native terminal text selection. Only the wheel-binding nuke is reversed.
- R6. `prefix None` and the `unbind-key -a` lockdown across `prefix`, `copy-mode`, and `copy-mode-vi` tables are preserved. Copy-mode entry is reachable only via the smart-wheel rule from R2.

**Right pane — Claude Code and Codex env defaults**

- R7. When orch invokes Codex in the right pane, `--no-alt-screen` (or `tui.alternate_screen: never`) is set by default. The flag ships in Codex v0.81.0-alpha.1.
- R8. When orch invokes Claude Code in the right pane, the default does not force `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`. Claude Code keeps its fullscreen renderer; users get scroll inside CC via R1 (mouse forwarding) and via `Ctrl+O` then `[` (CC's own transcript-dump to native scrollback).
- R9. Users can opt into tmux-level scrollback under Claude Code by setting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` in their environment. orch documents this knob but does not set it on the user's behalf.

**Left pane — Ink scrollable viewport**

- R10. The Ink steps-view supports keyboard-driven scroll: arrow keys (Up/Down), `j` / `k`, PageUp/PageDown, Home (jump to top), End (jump to bottom and resume live tail).
- R11. When new step events arrive while the user is scrolled away from the bottom, the viewport position stays put. No auto-scroll-to-tail. Live tail resumes only when the user explicitly jumps to End.
- R12. The steps-view renders a visible indicator (banner, chrome row, or status line — exact form is plan-time) when the viewport is not at the live tail, so the user can distinguish "scrolled" from "frozen."
- R13. Mouse wheel on the left pane is not bound to any scroll action. (The Ink canvas semantically rejects scrollback — see Problem Frame.)

**Discoverability**

- R14. Startup banner / `status-right` text updates to reflect the new behavior. The existing `logs --latest --follow` hint stays for power users, but the discoverability priority shifts to in-pane scroll (wheel for right, keys for left).
- R15. `docs/getting-started.md` is updated to document: smart-wheel behavior in the right pane, the Claude Code env-var opt-in, Codex's `--no-alt-screen` default, and the left-pane key map.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given Claude Code is running in the right pane in fullscreen mode (alt-screen on, mouse capture asserted), when the user scrolls the mouse wheel, the wheel event reaches Claude Code and Claude Code handles it according to its own scroll-speed setting. tmux copy-mode is not entered, and no `not in a mode` text appears in the pane.
- AE2. **Covers R2.** Given an autonomous step has emitted 200 lines into a `file-tail` pane (no alt-screen, no mouse capture), when the user scrolls the mouse wheel up, tmux enters one-shot copy-mode and the previous lines become visible. When the user scrolls back to the bottom, copy-mode exits and live output resumes.
- AE3. **Covers R11.** Given the user has scrolled the left pane up by 5 steps to re-read an earlier step's summary, when a new step starts and emits a `step:start` event, the steps-view does not scroll. The new step is visible only when the user presses End or scrolls down manually.
- AE4. **Covers R12.** Given the user is scrolled away from the live tail of the left pane, when they look at the pane, they see an indicator distinguishing "scrolled position" from "live tail" — a stalled viewport cannot be mistaken for a stalled orchestrator.
- AE5. **Covers R7.** Given orch starts a Codex step in the right pane, when Codex launches, it runs with `--no-alt-screen` by default. The user can observe partial scrollback through the smart-wheel binding (per R2 fallback) without needing to enter Codex's `Ctrl+T` pager.
- AE6. **Covers R8, R9.** Given a user launches orch with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` exported, when a Claude Code step runs in the right pane, CC's output flows into the normal buffer and tmux wheel scroll reveals full session history.

---

## Success Criteria

- A user can scroll back to previously emitted output in the right pane without leaving orch (no second-terminal context-switch) for autonomous file-tail output, Codex sessions (with `--no-alt-screen` default), and Claude Code sessions (via CC's own scroll or the opt-in env var).
- The user can scroll the left pane via keyboard to revisit earlier step summaries during a long-running orchestration, and live step events do not yank the viewport away.
- The `not in a mode` regression that motivated the strict sandbox does not return — verified by an integration test that runs a step, scrolls the wheel inside an alt-screen agent, and confirms no `not in a mode` text appears in the pane.
- A downstream planner reading this document can produce an implementation plan without re-litigating: tmux key-binding shape, history-limit value range, runner env defaults, or the keyboard scheme for the left pane.

---

## Scope Boundaries

- Side-channel pager pane (Approach B from the brainstorm dialogue) — swapping in `less -R +F <tee>` on demand — is deferred. The unified pane-map architecture supports adding it later; this document does not require it.
- Orch-owned fullscreen Ink transcript view (Approach E) with search, step-jumps, and copy-to-clipboard is deferred. If the hybrid here proves insufficient for long sessions, that's the natural follow-up.
- PTY recording (`script -f`, asciinema, or equivalent) of interactive runners is not in scope. Without it, replay-after-the-fact for an interactive PTY is not available; users see only what is in the tmux scrollback ring.
- Upstream Claude Code and Codex mouse-capture fixes are not orch's responsibility. orch's contract is to drive the agents according to the documented surfaces (env vars, CLI flags); the agents own their own wheel handling once they receive the event.
- Re-introducing arbitrary tmux prefix bindings, repopulating the copy-mode keytable, or relaxing any other element of the strict-sandbox lockdown is out of scope. Only the wheel-binding nuke and `history-limit 0` are reversed; everything else stays.
- iTerm2 `tmux -CC` integration mode is not supported. Per research, it silently fails with CC fullscreen; users wanting this combination must disable CC's alt-screen via R9's env var.

---

## Key Decisions

- **Smart wheel forwarding (tmux/tmux#3705), not surgical wheel rebind.** The conditional gates copy-mode entry on `alternate_on` + `mouse_any_flag` so the `not in a mode` regression cannot fire from the wheel path again. A naive "rebind wheel to forward" rule would reintroduce copy-mode access via other defaults; we keep the full lockdown on every keytable except for the one smart wheel binding.
- **`history-limit` target of ~50,000.** Covers typical multi-hour agent runs without measurable tmux memory pressure (research finding). Disk logs in `.orch/state/<runId>/logs/` remain the durable source of truth; tmux scrollback is UI convenience.
- **Codex `--no-alt-screen` on by default; Claude Code alt-screen left alone by default.** Asymmetric because Codex's flag is supported, ships from v0.81.0-alpha.1, and degrades cleanly under tmux. CC's env-var equivalent reintroduces flicker and memory growth that's worse than the scroll problem for the default user. Users who want CC scrollback opt in (R9).
- **Left-pane scroll is keyboard-driven, not wheel-driven.** Ink redraws the whole canvas on every model emission. Tmux scrollback for the left pane would only ever show the most recent frame, making wheel binding deceptive.
- **No auto-scroll-to-tail on new step events.** Mirrors the unified pane-map's "user intent over auto-jumping" rule. The visible scroll indicator (R12) prevents the user from mistaking a deliberate scrolled position for a frozen orchestrator.
- **The strict-sandbox brainstorm is amended, not superseded.** The lockdown's four-item allowlist, `prefix None`, and all-keytable wipe remain authoritative. This doc adds R1–R6 as the narrow reversal of the wheel + history-limit choices.

---

## Dependencies / Assumptions

- Tmux 3.3+ for the `if-shell -F` format and `mouse_any_flag` format string. The repo's documented floor is currently 3.2 — bump to 3.3 if required. Verify in planning.
- Codex CLI v0.81.0-alpha.1+ for the `--no-alt-screen` flag (PR openai/codex#8555). If orch supports older Codex pinned versions, R7 must include a graceful fallback path.
- Claude Code v2.1.89+ honors `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` per the fullscreen docs.
- The smart-wheel conditional depends on the embedded app correctly asserting mouse tracking when it owns the surface. Claude Code fullscreen does; Codex with `--no-alt-screen` does partially. The R3 fallback (`send-keys -M` rather than no-op) compensates for the partial case.
- The Ink steps-view's existing render pipeline (`StepsViewState` emissions → React re-render in `src/hosts/two-pane/steps-view/`) can host a scroll-offset state without re-architecting. The unified pane-map brainstorm's banner / view-indicator addition uses the same path, so this is a known-cheap extension.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R2][Technical] Exact `copy-mode -e` exit semantics on a fast wheel-up / wheel-down sequence — does one-shot exit fire on every wheel-down, or only when the buffer's bottom is reached?
- [Affects R4][Technical] Final `history-limit` value (40k vs 50k vs 100k) — measure tmux memory under a representative autonomous run and pick.
- [Affects R7][Needs research] Codex version detection — does orch already pin a known-good Codex version, and where does `--no-alt-screen` gating live if not?
- [Affects R10, R12][Technical] Exact Ink viewport implementation: scroll-offset state shape, indicator visual treatment, anchoring strategy when steps are added or removed, behavior when the visible slice no longer contains the focused step.
- [Affects R14][Technical] Final wording of the startup banner and `status-right` hint after the change. The strict-sandbox brainstorm pinned the current copy; this revises it.
- [Affects R3][Needs research] Confirm `send-keys -M` is a true no-op when the app has not asserted mouse capture (rather than producing a spurious mouse event in the agent's input), or fall back to an unconditional swallow in that branch.
