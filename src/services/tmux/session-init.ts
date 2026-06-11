// Composable lifecycle helpers for the strict appliance-mode tmux session.
// Intentionally thin — composes TmuxService + FsService calls without
// hiding any of them. The fake-service ordering test pins the exact call
// sequence as a regression guard (see plan §"Required call ordering").

import type { FsService } from '../fs/index.ts'
import type { Path } from '../types.ts'
import { path } from '../types.ts'
import type { BindKeyOptions, KeyTable, SocketName, TmuxService } from './tmux-service.ts'

export interface InitSessionOptions {
  readonly socket: SocketName
  readonly session: string
  readonly width: number
  readonly height: number
  /**
   * Shell command invoked when tmux's global `pane-died` hook fires. The
   * command is passed through to `tmux run-shell` verbatim, so callers are
   * responsible for quoting. Intended to signal a `wait-for` channel like
   * `wait-for -S pane-exit-#{hook_pane}`.
   */
  readonly paneDiedCommand: string
}

// ---------------------------------------------------------------------------
// Strict appliance-mode allowlist (PR A — tmux strict sandbox)
// ---------------------------------------------------------------------------
//
// Seven root-table interactions survive the lockdown, plus a small audited
// copy-mode allowlist so users can escape and scroll once they land there:
//
//   1. Drag pane border to resize         — MouseDrag1Border → resize-pane -M
//   2. Click pane to focus                — MouseDown1Pane   → select-pane -t=
//   3. Keyboard pane switch (left)        — M-Left           → select-pane -L
//   4. Keyboard pane switch (right)       — M-Right          → select-pane -R
//   5. Wheel up (smart, enters scrollback)— WheelUpPane      → if-shell -F …
//   6. Wheel down (smart, NEVER enters)   — WheelDownPane    → if-shell -F …
//   7. Drag to select+copy (plain panes)  — MouseDrag1Pane   → if-shell -F …
//
// Text selection / copy (V3 — see the not-copyable-text plan):
//   - Plain panes (the steps pane): MouseDrag1Pane enters tmux copy-mode and
//     `copy-selection-and-cancel` (bound in copy-mode below) yanks to the host
//     clipboard via OSC 52 (`set-clipboard on`). Per-pane, terminal-agnostic,
//     no modifier needed — this is exactly default-tmux behavior.
//   - Agent panes: Claude/Codex run full-screen mouse-reporting TUIs, so
//     `mouse_any_flag` is yes and their drags are forwarded to the agent by
//     design. Copy from an agent pane is therefore Shift-drag (Option on
//     macOS Terminal.app — the host terminal's native bypass) or the agent's
//     own `/copy` (OSC 52, enabled by `set-clipboard on` + `allow-passthrough
//     on`).
//
// Asymmetric wheel rule:
//   WheelUpPane:
//     mouse_any_flag yes → send-keys -M (forward; agent owns the wheel)
//     else if alternate_on → send-keys -M (alt-screen w/o mouse capture: safe
//                                          no-op forward; do NOT enter copy-
//                                          mode — that produced `not in a
//                                          mode` historically)
//     else → copy-mode -e (one-shot; exit at live tail)
//   WheelDownPane:
//     mouse_any_flag yes → send-keys -M
//     else if alternate_on → send-keys -M
//     else → (no command — explicitly do nothing)
//
// The asymmetry is deliberate. Scrolling DOWN at the live tail of a normal
// text pane has no legitimate "enter scrollback" intent — entering copy-mode
// from a wheel-down was a surprise on every report we've seen. Scrolling UP
// still enters scrollback per standard tmux UX.
//
// Encoded as nested `if-shell -F` argv. tmux's `bind-key` grammar accepts
// the inner if-shell as a single quoted token; verified empirically on tmux
// 3.6a against the real-tmux fixture (U2 characterization). When the inner
// if-shell has only the true branch, tmux's "no else command" semantics
// apply (man tmux: "If shell-command returns failure and a second command is
// not given, nothing happens").
//
// Copy-mode key tables get a small, explicit allowlist (see
// COPY_MODE_BINDINGS below) because tmux's modal scrolling routes ALL key
// events through the active mode's table — wiping the defaults without
// reinstalling exit + scroll commands traps the user with no escape (no `q`,
// no Escape, no arrows, no wheel scroll). See the trapped-in-copy-mode bug.

const SMART_WHEEL_UP_COMMAND: readonly string[] = [
  'if-shell',
  '-F',
  '#{?mouse_any_flag,1,0}',
  'send-keys -M',
  'if-shell -F "#{?alternate_on,1,0}" "send-keys -M" "copy-mode -e"',
] as const

// Symmetric with WheelUp on the mouse-capture / alt-screen branches, but the
// live-tail else branch is omitted. The inner if-shell has only its true
// branch — tmux does nothing when `alternate_on` is false.
const SMART_WHEEL_DOWN_COMMAND: readonly string[] = [
  'if-shell',
  '-F',
  '#{?mouse_any_flag,1,0}',
  'send-keys -M',
  'if-shell -F "#{?alternate_on,1,0}" "send-keys -M"',
] as const

// Plain drag-to-copy in a non-agent pane (the steps pane). Mirrors the
// `SMART_WHEEL_*` `if-shell -F #{?mouse_any_flag,…}` guard:
//   mouse_any_flag yes → send-keys -M (forward; the agent owns the mouse, so
//                        its drag is reported to the agent, never copy-mode)
//   else → copy-mode -M (enter copy-mode and begin a mouse selection)
// The drag-END event is bound under the copy-mode tables (COPY_MODE_KEYS),
// NOT here — once `copy-mode -M` runs the pane is in copy-mode, so the end
// event routes through the copy-mode table. Binding the end in root silently
// loses the yank (Phase 0 finding #1).
const SMART_DRAG_COMMAND: readonly string[] = [
  'if-shell',
  '-F',
  '#{?mouse_any_flag,1,0}',
  'send-keys -M',
  'copy-mode -M',
] as const

const ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = [
  { table: 'root', key: 'MouseDrag1Border', command: ['resize-pane', '-M'] },
  { table: 'root', key: 'MouseDown1Pane', command: ['select-pane', '-t='] },
  { table: 'root-no-prefix', key: 'M-Left', command: ['select-pane', '-L'] },
  { table: 'root-no-prefix', key: 'M-Right', command: ['select-pane', '-R'] },
  { table: 'root', key: 'WheelUpPane', command: SMART_WHEEL_UP_COMMAND },
  { table: 'root', key: 'WheelDownPane', command: SMART_WHEEL_DOWN_COMMAND },
  { table: 'root', key: 'MouseDrag1Pane', command: SMART_DRAG_COMMAND },
] as const

// Minimal copy-mode keymap. Installed identically under both `copy-mode` and
// `copy-mode-vi` so the user's preferred mode doesn't matter — orch is
// appliance mode, we own the bindings.
//
//   q, Escape, C-c → cancel       (exit copy-mode; load-bearing trap escape)
//   j / Down       → cursor-down
//   k / Up         → cursor-up
//   PageDown       → page-down
//   PageUp         → page-up
//   g              → history-top
//   G              → history-bottom
//   WheelUpPane    → scroll-up   -N 3
//   WheelDownPane  → scroll-down -N 3
//
// WheelDownPane in copy-mode IS bound (unlike in root) — once the user is
// already in scrollback, scrolling back down to the live tail is the natural
// way out. The `-e` flag on the entering `copy-mode -e` command makes
// reaching the bottom of history auto-exit copy-mode.
const COPY_MODE_KEYS: readonly { readonly key: string; readonly command: readonly string[] }[] = [
  { key: 'q', command: ['send-keys', '-X', 'cancel'] },
  { key: 'Escape', command: ['send-keys', '-X', 'cancel'] },
  { key: 'C-c', command: ['send-keys', '-X', 'cancel'] },
  { key: 'j', command: ['send-keys', '-X', 'cursor-down'] },
  { key: 'k', command: ['send-keys', '-X', 'cursor-up'] },
  { key: 'Down', command: ['send-keys', '-X', 'cursor-down'] },
  { key: 'Up', command: ['send-keys', '-X', 'cursor-up'] },
  { key: 'PageDown', command: ['send-keys', '-X', 'page-down'] },
  { key: 'PageUp', command: ['send-keys', '-X', 'page-up'] },
  { key: 'g', command: ['send-keys', '-X', 'history-top'] },
  { key: 'G', command: ['send-keys', '-X', 'history-bottom'] },
  { key: 'WheelUpPane', command: ['send-keys', '-X', '-N', '3', 'scroll-up'] },
  { key: 'WheelDownPane', command: ['send-keys', '-X', '-N', '3', 'scroll-down'] },
  // Drag-end yank for the V3 copy path. The MouseDrag1Pane root binding enters
  // copy-mode with `copy-mode -M`, so the release event lands HERE (in the
  // active mode's table), not in root — copying the selection to the host
  // clipboard (via `set-clipboard on`) and leaving copy-mode.
  { key: 'MouseDragEnd1Pane', command: ['send-keys', '-X', 'copy-selection-and-cancel'] },
] as const

const COPY_MODE_TABLES: readonly Extract<KeyTable, 'copy-mode' | 'copy-mode-vi'>[] = [
  'copy-mode',
  'copy-mode-vi',
] as const

const COPY_MODE_ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = COPY_MODE_TABLES.flatMap(
  (table) => COPY_MODE_KEYS.map((entry) => ({ table, key: entry.key, command: entry.command })),
)

// Wipe defaults across every key table that can fire `send-keys -X` against
// the running pane — root (default events before a prefix), prefix (events
// after the prefix key, neutralized by `prefix None`), and the two copy-mode
// tables. After wiping, the explicit allowlists below reinstall exactly the
// bindings we want; nothing else survives (tmux/tmux#638, tmux/tmux#3705).
const TABLES_TO_WIPE: readonly KeyTable[] = ['root', 'prefix', 'copy-mode', 'copy-mode-vi']

// Copy persisted in the tmux status bar at all times — survives
// `unbind-key -a` because status-right is an option, not a key binding.
// Points users at in-pane scroll first (the new primary path via the
// smart-wheel binding and the Ink keymap), then advertises drag-to-copy so
// the V3 selection path is discoverable (the reporter "couldn't copy" only
// because nothing surfaced it); `orch logs --latest --follow` remains the
// power-user fallback surfaced in the startup banner.
const STATUS_RIGHT_HINT = 'scroll: wheel up · j/k PgUp/PgDn · q exits · drag to copy'

/**
 * Create a new detached tmux session locked down to the appliance-mode
 * allowlist (drag-to-resize, click-to-focus, M-Left/Right pane switch,
 * drag-to-copy in plain panes). The exact call sequence is contract — see
 * plan §"Required call ordering" — and is asserted by the fake-service test.
 *
 * Required call ordering:
 *   1. `fs.writeFile(configPath, …)`   — generated `-f` config
 *   2. `tmux.createSession(configPath)` — pane is allocated under the config
 *   3. `tmux.unbindKey × 4`             — root → prefix → copy-mode → copy-mode-vi
 *   4. `tmux.bindKey × (root allowlist + copy-mode allowlist × 2 tables)`
 *      — root first (in `ALLOWLIST` order), then the copy-mode allowlist
 *        replicated under both `copy-mode` and `copy-mode-vi`
 *   5. `tmux.setOption(status-right)`   — discoverability hint
 *   6. `tmux.setHook(pane-died)`        — lifecycle wait-for signal
 *
 * `history-limit` is set BEFORE `new-session` via the generated `-f`
 * config. Tmux captures `history-limit` at pane allocation
 * (tmux/tmux#4705); a post-create `set -g history-limit <n>` does not
 * resize the initial pane's already-allocated grid. The `-f` path
 * bypasses this — the value is read before any pane exists.
 *
 * Hooks live in a separate namespace from key tables, so installing
 * `pane-died` AFTER the bindings is purely for clarity (it would survive
 * either way).
 */
export const initOrchSession = async (
  tmux: TmuxService,
  fs: FsService,
  opts: InitSessionOptions,
): Promise<void> => {
  const configPath = await writeAppliancConfig(fs)

  await tmux.createSession({
    socket: opts.socket,
    session: opts.session,
    width: opts.width,
    height: opts.height,
    configPath,
  })

  for (const table of TABLES_TO_WIPE) {
    await tmux.unbindKey({ socket: opts.socket, table })
  }

  for (const item of ALLOWLIST) {
    await tmux.bindKey({ socket: opts.socket, ...item })
  }

  // Reinstall the minimal copy-mode keymap under both `copy-mode` and
  // `copy-mode-vi`. Without this, the user is trapped the moment a wheel-up
  // event lands them in copy-mode: no `q` to exit, no arrows or wheel to
  // scroll, no Ctrl-C — every key event routes through an empty table.
  for (const item of COPY_MODE_ALLOWLIST) {
    await tmux.bindKey({ socket: opts.socket, ...item })
  }

  // Permanent status-right hint — the load-bearing replacement for the
  // wheel-into-copy-mode discoverability that the lockdown removes.
  await tmux.setOption({
    socket: opts.socket,
    target: opts.session,
    name: 'status-right',
    value: STATUS_RIGHT_HINT,
    global: true,
  })

  await tmux.setHook({
    socket: opts.socket,
    hook: 'pane-died',
    command: opts.paneDiedCommand,
    global: true,
  })
}

const APPLIANCE_CONFIG_LINES = [
  // Pane allocation reads history-limit at create time (tmux/tmux#4705).
  // Setting it here, in the `-f` config, is the only way to ensure both
  // the initial pane and every later split pane get the full buffer at
  // allocation; a post-create `set -g history-limit` would not retroactively
  // resize the initial pane's grid.
  'set -g history-limit 50000',
  // Drag-to-resize and click-to-focus rely on mouse mode. Mouse mode also
  // makes the host terminal stop seeing raw drags, so plain text selection is
  // restored by the MouseDrag1Pane copy-mode binding below (V3 — see the
  // not-copyable-text plan), not by the host terminal.
  'set -g mouse on',
  // Let tmux/agents write the *host* clipboard via OSC 52. Load-bearing for
  // two copy paths: (a) the copy-mode drag yank below
  // (`copy-selection-and-cancel`) reaches the real clipboard, and (b)
  // Claude/Codex `/copy` lands on the host clipboard, including over SSH.
  'set -g set-clipboard on',
  // Required (tmux >= 3.3, our enforced floor — see detect-tmux.ts) so the
  // agents' DCS-wrapped OSC 52 sequences pass through to the outer terminal
  // instead of being swallowed by tmux.
  'set -g allow-passthrough on',
  // Native-looking blue copy-mode selection. tmux's default `mode-style` is an
  // ugly yellow; this muted blue reads like a normal terminal selection
  // (a Phase 0 finding from the not-copyable-text experiment).
  "set -g mode-style 'bg=#214283,fg=#ffffff'",
  // Keep dead panes visible so `pane-died` fires on every exit (the hook
  // only runs for exits remain-on-exit keeps visible). The `respawn-pane
  // -k` cycle replaces the dead pane with a fresh `cat` immediately after,
  // so the "[exited]" splash is only briefly visible between steps.
  'set -g remain-on-exit on',
  // No prefix means C-b (and any other prefix) is inert — the keystroke
  // passes through to the running shell/agent unmodified. Supported by
  // tmux 2.4+; orch's floor is 3.3 (see detect-tmux.ts).
  'set -g prefix None',
  // Latest-attaching client drives the window grid. Without this, two clients
  // (e.g. parent's auto-attach + the steps-view replay window) negotiate to
  // the smallest size and letterbox the larger client. Phase 2's two-window
  // dance assumes this so window 1's replay can render at the full pane.
  'set -g window-size latest',
  // Keep the per-run tmux server alive even if every session momentarily
  // empties. Orch tears the server down explicitly in `host.teardown()`; we
  // never want tmux's own `exit-empty on` default to dissolve the server
  // mid-run if a session goes pane-less for a beat (see incident
  // r-2026-05-22-093650-j0). Server scope (`-s`) — not session scope.
  'set -s exit-empty off',
  // Per-source tmux sessions (`orch-src-<sanitized-key>`) are deliberately
  // unattached — no client ever attaches to them; they exist only as
  // swap-pane sources. A user's `~/.tmux.conf` with `destroy-unattached on`
  // would otherwise reap them the moment they were created. Pin off
  // globally before any source session is created. Server-wide scope keeps
  // it in effect for every session the run creates without a per-session
  // setOption (which is version-sensitive for this option). The orch run
  // owns the per-run tmux server, so a global option is scoped to this
  // run only. See the per-source-tmux-sessions plan.
  'set -g destroy-unattached off',
  // Pane-focus affordance (P6): with keyboard focus switching (Tab from the
  // steps view, M-Left/M-Right anywhere) the user needs to SEE which pane
  // owns the keyboard. Cyan active border matches the steps-view accent;
  // the inactive border stays the dim default-ish gray.
  'set -g pane-border-style fg=brightblack',
  'set -g pane-active-border-style fg=cyan',
] as const

const writeAppliancConfig = async (fs: FsService): Promise<Path> => {
  const dir = await fs.tempDir('orch-tmux-')
  const file = path(`${dir}/init.tmux.conf`)
  await fs.writeFile(file, `${APPLIANCE_CONFIG_LINES.join('\n')}\n`)
  return file
}
