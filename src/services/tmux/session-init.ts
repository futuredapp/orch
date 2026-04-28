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
 * - `remain-on-exit on` — keep every dead pane visible (success and
 *   failure alike). The post-step `respawn-pane -k` immediately replaces
 *   the dead pane with a fresh `cat`, so the "[exited]" splash only
 *   appears for the brief window between the agent exiting and the next
 *   step taking over (or teardown). The earlier `remain-on-exit failed`
 *   value was wrong: tmux's `pane-died` hook fires only for exits that
 *   `remain-on-exit` keeps visible, so a clean (exit-0) agent exit closed
 *   the pane silently and the per-pane `wait-for` channel was never
 *   signaled — `runInteractive()` then hung in `waitFor` for the full
 *   1-hour cap.
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
    value: 'on',
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
