// Composable lifecycle helpers. Intentionally thin — they compose
// TmuxService calls without hiding any of them. Full wiring into
// workflow execution arrives with the status renderer in phase 13c;
// these helpers make the expected lifecycle explicit now so callers
// in 13c don't invent their own sequence.

import type { SocketName, TmuxService } from './tmux-service.ts'

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

/**
 * Create a new detached tmux session and install the lifecycle options +
 * hooks every step relies on:
 *
 * - `remain-on-exit failed` — keep dead panes visible so errors can be
 *   inspected. Requires tmux >= 3.2; fallback to `on` for older tmux is
 *   the caller's concern.
 * - `mouse on` — let users drag pane borders to resize, click to focus,
 *   and wheel-scroll into copy mode. Hold Shift (or Option on macOS) for
 *   native terminal text selection when needed.
 * - global `pane-died` hook — fires once per pane death. Per-pane hooks
 *   have known bugs in tmux, so we use `-g` only.
 */
export const initOrchSession = async (
  tmux: TmuxService,
  opts: InitSessionOptions,
): Promise<void> => {
  await tmux.createSession({
    socket: opts.socket,
    session: opts.session,
    width: opts.width,
    height: opts.height,
  })

  await tmux.setOption({
    socket: opts.socket,
    target: opts.session,
    name: 'remain-on-exit',
    value: 'failed',
    global: true,
  })

  await tmux.setOption({
    socket: opts.socket,
    target: opts.session,
    name: 'mouse',
    value: 'on',
    global: true,
  })

  await tmux.setHook({
    socket: opts.socket,
    hook: 'pane-died',
    command: opts.paneDiedCommand,
    global: true,
  })
}
