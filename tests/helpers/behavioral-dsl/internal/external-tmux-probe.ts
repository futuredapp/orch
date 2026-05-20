/**
 * `ExternalTmuxProbe` — the harness's second `RealTmuxService` instance
 * pointing at the running orch process's tmux socket, plus harness-only
 * destructive verbs (`killServer`) and mouse-event injection
 * (`sendMouseEvent`) that don't belong in the production `TmuxService` port.
 *
 * U1 is scaffold only. Real implementation lands in U5 — it composes:
 *   - the new production `TmuxService.hasSession` / `hasServer` methods (U5)
 *   - `tmux kill-server` / `tmux send-keys -t <pane> -M <sgr>` via
 *     `ProcessService` directly (CLAUDE.md rule #1 honored — the harness lives
 *     under `tests/` but routes subprocess calls through `ProcessService` like
 *     a runner would).
 */

import type { OrchHandle } from './lifecycle-handle.ts'

export type MouseButton = 'left' | 'middle' | 'right'

export interface SendMouseEventOptions {
  readonly pane: 'left' | 'right'
  /** Column in the tmux window. Defaults to the center of the named pane. */
  readonly col?: number
  /** Row in the tmux window. Defaults to the center of the named pane. */
  readonly row?: number
  readonly button: MouseButton
}

/**
 * Returned by U5's factory once the full implementation is in place. U1
 * declares the surface so U6 / U7 / U8 can type-check their imports.
 */
export interface ExternalTmuxProbe {
  hasSession(): Promise<boolean>
  hasServer(): Promise<boolean>
  killServer(): Promise<void>
  sendMouseEvent(opts: SendMouseEventOptions): Promise<void>
}

export const createExternalTmuxProbe = (_handle: OrchHandle): ExternalTmuxProbe => {
  throw new Error('createExternalTmuxProbe not yet implemented — lands in U5')
}
