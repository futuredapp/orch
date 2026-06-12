# Fix: text not copyable from any pane in the two-pane tmux TUI

## Context

A bug report says users cannot copy/paste (select with the mouse to copy) text from **any** pane in orch's two-pane TUI — not the Claude Code pane, not the Codex pane, not the left "steps" pane.

**Why a normal Claude/Codex session is different (the user's key observation):** outside orch there is no tmux, so the host terminal handles mouse selection natively and you can drag-copy almost anything. The moment orch wraps the agents in tmux with `set -g mouse on`, the tmux server captures every mouse event before the terminal sees it, so native click-drag selection stops working in all panes.

**Root cause (confirmed in code):** `src/services/tmux/session-init.ts:242` sets `set -g mouse on`. The appliance session also wipes every key table (`unbind-key -a` over root/prefix/copy-mode/copy-mode-vi, `TABLES_TO_WIPE` line 150) and reinstalls only a 6-entry allowlist (lines 93–100). Result: with mouse on and the root table wiped, a mouse drag inside a pane does nothing in tmux, *and* tmux's mouse capture blocks the terminal's own selection. There is **no** `set-clipboard`, **no** `allow-passthrough`, and **no** copy binding anywhere in the project.

**The intended escape hatch already exists but is invisible:** the file comment at `session-init.ts:39–41` documents that holding **Shift** (or **Option** on macOS Terminal.app) bypasses tmux mouse capture and uses the host terminal's native selection. This works on iTerm2, Kitty, WezTerm, Alacritty, Ghostty, GNOME Terminal, Windows Terminal. But `STATUS_RIGHT_HINT` (line 157) never mentions selection/copy, so a user has no way to discover it and reports "I can't copy."

**Reframe that drives the design** (validated by an adversarial review):
- **Claude Code & Codex panes** run full-screen alt-screen TUIs with mouse reporting ON, so `mouse_any_flag` is *yes* for the whole session. A tmux copy-mode mouse-drag binding **cannot** work in these panes — the drag is forwarded to the agent. The only ways to get text out of these two panes are (a) the terminal's native **Shift/Option-drag** bypass, or (b) the agent's own copy writing to the host clipboard via **OSC 52** (which needs `set-clipboard on` + `allow-passthrough on`).
- **Left steps pane** is plain text with no mouse capture, so native Shift-drag already works there, and a guarded tmux drag-to-copy binding would *also* work — but only there.

So the mechanism that covers all three panes is the **native Shift/Option-drag bypass made discoverable**, plus **OSC 52** for programmatic agent copies. A tmux drag-to-copy binding is optional polish for the steps pane only.

> **Update after Phase 0:** the experiment overturned the "optional polish" framing. The native Shift/Option-drag path bleeds across panes for plain-pane selection (it's the host terminal, which can't see the tmux divider), so the tmux drag-to-copy binding (V3) is the **primary** mechanism for the steps pane, not polish. Shift-drag/OSC 52 remain the only options for the *agent* panes. See "Phase 0 results" below — **V3 won**.

**Decision posture (user request):** before committing to a config, *measure*. The user wants to launch tmux with different settings, run real Claude/Codex inside, and see what actually restores copy. Phase 0 below is that experiment; Phases 1–3 implement whatever wins.

**Verified facts:** enforced tmux floor is **3.3** (`src/cli/detect-tmux.ts:12–13`), so `allow-passthrough on` (settable since 3.3) is safe at the floor. The "3.2" in the `session-init.ts:250` comment is stale and should be corrected. `BindKeyOptions.command` accepts raw argv, so `send-keys -X begin-selection` / `copy-selection-and-cancel` are reachable through the existing `TmuxService` interface — no interface change needed.

---

## Phase 0 — Empirical experiment (decide the config from evidence)

Goal: determine which tmux settings restore copy in each pane, on the relevant terminal(s). The copy attempts in the agent panes are inherently manual (a human drags and pastes), but the macOS clipboard can be read back with `pbpaste`, and OSC 52 can be driven programmatically.

**Build a throwaway launcher** `scripts/copy-experiment.ts` (Bun, uses the existing `RealTmuxService` from `src/services/tmux/index.ts` and `ProcessService` from `src/services/process/index.ts` — do **not** shell out to tmux directly; honor rule #1). For each variant it: writes a `-f` config, starts a detached session on an isolated socket (`orch-copy-exp-<variant>`), splits a left "steps" placeholder pane (`cat` echoing a few labeled lines) and a right pane running the real agent (`claude` or `codex`), prints the `tmux -L <socket> attach` command, and waits.

Variant matrix (one socket each, so several can be compared back-to-back):

| # | Config | What we expect to learn |
|---|--------|--------------------------|
| V0 | current appliance config verbatim (`mouse on`, no clipboard opts) | reproduce the bug; confirm plain drag fails and whether Shift/Option-drag already works |
| V1 | `mouse off` | does unmodified native selection return everywhere (and confirm we lose drag-resize) |
| V2 | `mouse on` + `set -g set-clipboard on` + `set -g allow-passthrough on` | does the agent's own copy (Claude `/copy` etc.) land on the host clipboard; does selection change |
| V3 | V2 + guarded `MouseDrag1Pane`/`MouseDragEnd1Pane` → copy-mode begin-selection / `copy-selection-and-cancel`, mirroring the `SMART_WHEEL_*` `if-shell -F #{?mouse_any_flag,…}` shape | does plain drag-to-copy work in the **steps** pane without stealing the agents' mouse |

**Per-variant manual test script** (tester attaches, then for each of the 3 panes):
1. Plain mouse drag-select → try paste elsewhere; run `pbpaste` to see what landed.
2. **Shift**-drag (and **Option**-drag for Terminal.app) → paste / `pbpaste`.
3. In the Claude pane, trigger the agent's own copy (e.g. `/copy` if available) → `pbpaste` to verify OSC 52 reached the host clipboard (V2/V3 only).
4. Confirm drag-to-resize (border drag) and click-to-focus still behave (regression check, esp. V1/V3).

**Decision rule:** pick the lowest-surface variant that makes all three panes copyable on the target terminals.
- If Shift/Option-drag already works in V0 on the reporter's terminal → the bug is **pure discoverability**; ship Phase 1 "minimal" (hint + docs) and add V2's clipboard opts only if the agent `/copy` path needs them.
- If V0 Shift-drag fails but V2 helps the agent panes → ship V2.
- Add V3's drag binding only if we want modifier-free copy in the steps pane and it shows no interference with resize/focus/wheel.

Record results inline in this plan before implementing. `scripts/copy-experiment.ts` is throwaway — delete it after, or keep under `scripts/` if generally useful (user prefers reusable scripts over ad-hoc commands).

### Phase 0 results (run 2026-06-11, macOS, dark terminal)

The launcher was built as `scripts/copy-experiment.ts` (reuses `RealTmuxService` + `BunProcessService` + `initOrchSession`; one isolated socket `orch-copy-exp-<variant>` each). Verified live on **tmux 3.6a**. Findings per variant:

| # | Outcome | Notes |
|---|---------|-------|
| **V0** | ❌ does not work | reproduces the bug — plain drag does nothing, no copy |
| **V1** (`mouse off`) | ⚠️ copies, but **bleeds across both panes** | Closest "feel", but **fatally flawed**: with mouse off tmux is transparent to the mouse and the **host terminal** does the selection over the raw screen grid — it has no concept of tmux panes or the `│` divider, so every drag selects a full-width rectangle spanning both panes + the separator. **This is intrinsic and unfixable** — no tmux option can make the host terminal's native selection pane-aware when tmux is out of the loop. |
| **V2** (`set-clipboard` + `allow-passthrough`) | ❌ no visible copy/paste | OSC 52 alone does nothing for the host terminal's own native selection; it only helps *programmatic* copies the agent/tmux make. |
| **V3** (V2 + guarded `MouseDrag` pair) | ✅ **works, native tmux behavior** | Matches what the user saw with a plain `tmux new-session -s claude 'claude'`. Steps pane: plain drag (no Shift) selects and copies. Agent panes: agent owns the mouse, so Shift-drag (native) or the agent's own `/copy` (OSC 52). |

**Two bugs in the first V3 cut were found and fixed during the experiment** (both are now baked into the recommended config below):

1. **Drag-end must be bound in the `copy-mode` / `copy-mode-vi` tables, NOT `root`.** Once `MouseDrag1Pane` runs `copy-mode -M`, the pane is *in copy-mode*, so the drag-**end** event routes through the copy-mode table. Binding `MouseDragEnd1Pane` in `root` (the first cut) means the yank never fires and the selection is lost ("kind of works / had to press shift"). This mirrors default tmux, which binds `MouseDragEnd1Pane` under copy-mode. **This resolves the open V3 risk in §Risks** — the fallback (bind in copy-mode) is in fact the *required* path, not a fallback.
2. **Default `mode-style` is an ugly yellow ("weird color").** Set `set -g mode-style 'bg=#214283,fg=#ffffff'` (muted blue) so the copy-mode selection reads like a native terminal selection.

**Decision: ship V3.** It is the lowest-surface variant that makes copy work *per-pane* (no cross-pane bleed) on the target terminal, and it is exactly default-tmux behavior so it "feels native." V1's bleed disqualifies it; V0/V2 don't restore selection. Phases 1–2 below are updated to implement V3.

Confirmed-live config on the V3 server (via `show-options` / `list-keys`):
```
set -g mouse on
set -g set-clipboard on
set -g allow-passthrough on
set -g mode-style 'bg=#214283,fg=#ffffff'
bind -T root         MouseDrag1Pane    if-shell -F "#{?mouse_any_flag,1,0}" "send-keys -M" "copy-mode -M"
bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
```

---

## Phase 1 — Implement the chosen config

All edits in **`src/services/tmux/session-init.ts`**. **Phase 0 chose V3** — default-tmux per-pane mouse-copy + OSC 52 + a native-blue selection color + discoverability. Concretely:

1. **Add to `APPLIANCE_CONFIG_LINES`** (after `set -g mouse on`, line 242), with comments in the file's heavy-comment style:
   - `set -g set-clipboard on` — let tmux/agents write the host clipboard via OSC 52 (so the copy-mode drag yank below — and Claude/Codex `/copy` — reach the real clipboard, incl. over SSH).
   - `set -g allow-passthrough on` — required (tmux ≥3.3, our floor) so the agents' DCS-wrapped OSC 52 sequences pass through to the outer terminal instead of being swallowed.
   - `set -g mode-style 'bg=#214283,fg=#ffffff'` — native-looking blue copy-mode selection (default is an ugly yellow; this was a Phase 0 finding).
   - Set these in the `-f` config (a bad option line there only warns, it does not abort `new-session`), rather than a post-create `setOption` (which throws `TmuxCommandError` on non-zero exit per `real-tmux-service.ts`) — keeps us tolerant if the floor is ever lowered. (The Phase 0 rig used `setOption` for convenience; the shipped config uses the `-f` lines.)
2. **Add the V3 drag bindings.** Begin in `root`, end in **both copy-mode tables** (load-bearing — see Phase 0 finding #1; binding end in `root` silently loses the yank):
   - To `ALLOWLIST` (root): `{ table: 'root', key: 'MouseDrag1Pane', command: ['if-shell','-F','#{?mouse_any_flag,1,0}','send-keys -M','copy-mode -M'] }` — `SMART_WHEEL`-style guard so agent panes (`mouse_any_flag` = yes) keep their mouse and only plain panes enter copy-mode.
   - To `COPY_MODE_KEYS` (replicated under `copy-mode` + `copy-mode-vi` via the existing `COPY_MODE_ALLOWLIST` flatMap): `{ key: 'MouseDragEnd1Pane', command: ['send-keys','-X','copy-selection-and-cancel'] }`.
   - Update the "Six root-table interactions" comment (now seven) and the `initOrchSession` "Required call ordering" docblock.
3. **Update `STATUS_RIGHT_HINT`** (line 157) to advertise selection/copy, e.g. append `· drag to copy`. Note in docs that agent panes need Shift-drag (Option on Terminal.app) or the agent's own `/copy`.
4. **Fix the now-misleading comments:** the "Native terminal text selection survives by NOT touching it" paragraph (lines 39–41 — it's now tmux copy-mode drag, not host-native, that does the work in plain panes) and the "orch's floor is 3.2" comment (line 250 → 3.3).

Also update **`docs/getting-started.md`** (and any public terminal/troubleshooting doc) with a short "Copying text from the panes" note: Shift-drag (Option on Terminal.app); mention the per-terminal modifier; load `doc-writer` skill before editing public docs.

---

## Phase 2 — Tests (lock in the chosen config)

Automated tests can prove the **config is emitted**, not that a human can copy (that stays manual — see Verification). Extend the existing contract tests:

1. **`tests/tmux-argv/services/tmux/session-init.test.ts`** (fake-service contract):
   - Assert the written `-f` config `toContain('set -g set-clipboard on')`, `'set -g allow-passthrough on'`, and `"set -g mode-style 'bg=#214283,fg=#ffffff'"` (mirror the existing `set -g mouse on` assertion at lines 32–57).
   - Extend the **root** bindings ordering assertion from **6 → 7** entries (the new `MouseDrag1Pane` is the added root key) and add an `if-shell`-shape test for it (mirror the existing `SMART_WHEEL` characterization). Bump the copy-mode `slice(6)` → `slice(7)`.
   - Assert the **copy-mode allowlist** now includes `MouseDragEnd1Pane → send-keys -X copy-selection-and-cancel` under *both* `copy-mode` and `copy-mode-vi` (it rides the existing `COPY_MODE_KEYS` flatMap, so per-table key count goes up by one).
2. **`tests/integration/services/tmux/tmux-real.integration.test.ts`** (real tmux, env-gated): add `show-options -g set-clipboard`, `-g allow-passthrough`, and `-g mode-style` assertions following the existing `show-options -g prefix` / `status-right` pattern (around lines 640–744). Add `list-keys -T root` (MouseDrag1Pane) and `list-keys -T copy-mode` / `-T copy-mode-vi` (MouseDragEnd1Pane) assertions for the drag bindings — these were verified by hand in Phase 0, so the expected strings are known.

Gate: `bun run check` green; `bun run check:release` for the gated real-tmux level. Default loop command `bun run test:two-pane:fast` (never bare `bun test`).

---

## Verification (end-to-end)

- **Automated:** `bun run check` (config-emission + ordering tests) and the env-gated `tmux-real.integration.test.ts` (`show-options` confirms the options are live on a real server).
- **Manual (the real proof, unavoidable):** run `scripts/copy-experiment.ts` (or a real orch run after the fix) and confirm in each pane: Shift/Option-drag selects and `pbpaste` shows the text; the agent's own `/copy` lands on the clipboard (OSC 52); drag-resize and click-to-focus still work; the status bar shows the copy hint. Since the reporter's terminal is unknown, verify on at least iTerm2 + Terminal.app (Option-drag, weaker OSC 52) before closing the bug.
- The `orch-qa-engineer` / `scriptedFake` path can screenshot the panes and the new status hint but **cannot** assert clipboard contents — note this as a coverage gap.

---

## Critical files

- `src/services/tmux/session-init.ts` — the appliance config + allowlist + ordering (primary change)
- `src/cli/detect-tmux.ts` — tmux floor (3.3; confirms `allow-passthrough` safety)
- `tests/tmux-argv/services/tmux/session-init.test.ts` — config-content + ordering contract test
- `tests/integration/services/tmux/tmux-real.integration.test.ts` — real-tmux `show-options` assertions
- `docs/getting-started.md` (+ public terminal/troubleshooting doc) — discoverability note
- `scripts/copy-experiment.ts` — new throwaway Phase 0 launcher (uses `RealTmuxService` + `ProcessService`)

## Risks / open questions

- **V3 binding routing — RESOLVED in Phase 0.** Confirmed on tmux 3.6a that the drag-**end** event routes through the *copy-mode* table (because `copy-mode -M` has already entered the mode), so `MouseDragEnd1Pane` **must** be bound under `copy-mode` + `copy-mode-vi`, not `root`. The earlier "fallback" is the required path. The real-tmux integration test pins this so a future tmux can't silently regress it.
- **Steps pane no longer depends on host-native selection.** With V3, plain panes copy via tmux's own copy-mode drag, which is terminal-agnostic — so the steps pane works on any terminal at the 3.3 floor. The host-terminal Shift/Option-drag path now only matters for the **agent panes** (where the agent owns the mouse).
- **Agent panes remain Shift/`/copy`-only (inherent, not a bug).** Claude/Codex run full-screen mouse-reporting TUIs (`mouse_any_flag` = yes), so their drags are forwarded to the agent by design. Copy from an agent pane is therefore: Shift-drag (host-native, terminal-dependent) **or** the agent's own `/copy` → OSC 52 (needs `set-clipboard on` + `allow-passthrough on`, both shipped). If a terminal has *neither* a Shift bypass *nor* OSC 52 support (rare), agent-pane copy still isn't possible — document this as a known limitation rather than regressing the whole session to `mouse off`.
- **No `pbcopy`/`xclip`/`wl-copy` pipe** in the binding: prefer pure OSC 52 (`set-clipboard on`) to avoid platform branching and subprocess spawns from inside the sandboxed appliance (there is no OS/clipboard service in `src/` to hang that on). `copy-selection-and-cancel` + `set-clipboard on` is the OSC-52 path; do **not** use `copy-pipe-and-cancel pbcopy` (tmux's macOS default) — it shells out and is macOS-only.
