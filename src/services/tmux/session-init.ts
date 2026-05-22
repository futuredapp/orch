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
// Six interactions survive the lockdown:
//
//   1. Drag pane border to resize         — MouseDrag1Border → resize-pane -M
//   2. Click pane to focus                — MouseDown1Pane   → select-pane -t=
//   3. Keyboard pane switch (left)        — M-Left           → select-pane -L
//   4. Keyboard pane switch (right)       — M-Right          → select-pane -R
//   5. Wheel up (smart)                   — WheelUpPane      → if-shell -F …
//   6. Wheel down (smart)                 — WheelDownPane    → if-shell -F …
//
// Native terminal text selection survives by NOT touching it — users hold
// Shift (or Option on macOS Terminal) to bypass tmux mouse capture and use
// the host terminal's own selection.
//
// Smart-wheel rule (R1/R2/R3 from the scrollable-two-pane plan):
//   mouse_any_flag? — the app has asserted mouse tracking
//     yes  → send-keys -M           (forward; agent owns the wheel)
//     no   → alternate_on?
//              yes → send-keys -M    (alt-screen w/o mouse capture: safe no-op
//                                     fallback; do NOT enter copy-mode — that
//                                     is the precise case that produced
//                                     `not in a mode` historically)
//              no  → copy-mode -e    (one-shot; exit at live tail)
//
// Encoded as nested `if-shell -F` argv. tmux's `bind-key` grammar accepts the
// inner if-shell as a single quoted token; verified empirically on tmux 3.6a
// against the real-tmux fixture (U2 characterization).
//
// `copy-mode` and `copy-mode-vi` tables stay empty per R6: once the user is
// in copy-mode, tmux's built-in modal scrolling handles further wheel events
// — copy-mode entry is reachable only via this root-table rule, and exit is
// automatic at the live tail via `-e`.

const SMART_WHEEL_COMMAND: readonly string[] = [
  'if-shell',
  '-F',
  '#{?mouse_any_flag,1,0}',
  'send-keys -M',
  'if-shell -F "#{?alternate_on,1,0}" "send-keys -M" "copy-mode -e"',
] as const

const ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = [
  { table: 'root', key: 'MouseDrag1Border', command: ['resize-pane', '-M'] },
  { table: 'root', key: 'MouseDown1Pane', command: ['select-pane', '-t='] },
  { table: 'root-no-prefix', key: 'M-Left', command: ['select-pane', '-L'] },
  { table: 'root-no-prefix', key: 'M-Right', command: ['select-pane', '-R'] },
  { table: 'root', key: 'WheelUpPane', command: SMART_WHEEL_COMMAND },
  { table: 'root', key: 'WheelDownPane', command: SMART_WHEEL_COMMAND },
] as const

// `prefix` and `copy-mode` / `copy-mode-vi` are the four namespaces that
// can fire `send-keys -X` against the running pane. Wiping all of them
// removes every default callsite; the next wheel/key event after a stray
// copy-mode entry/exit can no longer leak `not in a mode` into the visible
// stream (tmux/tmux#638, tmux/tmux#3705).
const TABLES_TO_WIPE: readonly KeyTable[] = ['root', 'prefix', 'copy-mode', 'copy-mode-vi']

// Copy persisted in the tmux status bar at all times — survives
// `unbind-key -a` because status-right is an option, not a key binding.
// Points users at in-pane scroll first (the new primary path via the
// smart-wheel binding and the Ink keymap); `orch logs --latest --follow`
// remains the power-user fallback surfaced in the startup banner.
const STATUS_RIGHT_HINT = 'scroll: wheel · keys j/k PgUp/PgDn'

/**
 * Create a new detached tmux session locked down to the appliance-mode
 * allowlist (drag-to-resize, click-to-focus, M-Left/Right pane switch,
 * native text selection). The exact call sequence is contract — see plan
 * §"Required call ordering" — and is asserted by the fake-service test.
 *
 * Required call ordering:
 *   1. `fs.writeFile(configPath, …)`   — generated `-f` config
 *   2. `tmux.createSession(configPath)` — pane is allocated under the config
 *   3. `tmux.unbindKey × 4`             — root → prefix → copy-mode → copy-mode-vi
 *   4. `tmux.bindKey × 4`               — the allowlist, in order
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
  // Drag-to-resize and click-to-focus rely on mouse mode.
  'set -g mouse on',
  // Keep dead panes visible so `pane-died` fires on every exit (the hook
  // only runs for exits remain-on-exit keeps visible). The `respawn-pane
  // -k` cycle replaces the dead pane with a fresh `cat` immediately after,
  // so the "[exited]" splash is only briefly visible between steps.
  'set -g remain-on-exit on',
  // No prefix means C-b (and any other prefix) is inert — the keystroke
  // passes through to the running shell/agent unmodified. Supported by
  // tmux 2.4+; orch's floor is 3.2.
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
] as const

const writeAppliancConfig = async (fs: FsService): Promise<Path> => {
  const dir = await fs.tempDir('orch-tmux-')
  const file = path(`${dir}/init.tmux.conf`)
  await fs.writeFile(file, `${APPLIANCE_CONFIG_LINES.join('\n')}\n`)
  return file
}
