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
// Exactly four interactions survive the lockdown:
//
//   1. Drag pane border to resize        — MouseDrag1Border → resize-pane -M
//   2. Click pane to focus               — MouseDown1Pane   → select-pane -t=
//   3. Keyboard pane switch (left)       — M-Left           → select-pane -L
//   4. Keyboard pane switch (right)      — M-Right          → select-pane -R
//
// Native terminal text selection survives by NOT touching it — users hold
// Shift (or Option on macOS Terminal) to bypass tmux mouse capture and use
// the host terminal's own selection. Wheel events are deliberately NOT
// rebound; discoverability of `orch logs --latest --follow` lives in the
// permanent `status-right` hint installed below.

const ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = [
  { table: 'root', key: 'MouseDrag1Border', command: ['resize-pane', '-M'] },
  { table: 'root', key: 'MouseDown1Pane', command: ['select-pane', '-t='] },
  { table: 'root-no-prefix', key: 'M-Left', command: ['select-pane', '-L'] },
  { table: 'root-no-prefix', key: 'M-Right', command: ['select-pane', '-R'] },
] as const

// `prefix` and `copy-mode` / `copy-mode-vi` are the four namespaces that
// can fire `send-keys -X` against the running pane. Wiping all of them
// removes every default callsite; the next wheel/key event after a stray
// copy-mode entry/exit can no longer leak `not in a mode` into the visible
// stream (tmux/tmux#638, tmux/tmux#3705).
const TABLES_TO_WIPE: readonly KeyTable[] = ['root', 'prefix', 'copy-mode', 'copy-mode-vi']

// Copy persisted in the tmux status bar at all times — survives
// `unbind-key -a` because status-right is an option, not a key binding.
const STATUS_RIGHT_HINT = 'logs --latest --follow'

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
 * `history-limit 0` is set BEFORE `new-session` via the generated `-f`
 * config. Tmux captures `history-limit` at pane allocation
 * (tmux/tmux#4705); a post-create `set -g history-limit 0` does not
 * shrink the initial pane's already-allocated grid. The `-f` path
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
  // Setting it here, in the `-f` config, is the only way to give the
  // initial pane a zero-size grid.
  'set -g history-limit 0',
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
] as const

const writeAppliancConfig = async (fs: FsService): Promise<Path> => {
  const dir = await fs.tempDir('orch-tmux-')
  const file = path(`${dir}/init.tmux.conf`)
  await fs.writeFile(file, `${APPLIANCE_CONFIG_LINES.join('\n')}\n`)
  return file
}
