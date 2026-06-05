// PaneHandle — typed handle for capturing visible pane content and waiting
// for predicates against it.
//
// Tier 1 tests assert on what the user sees, not what the host service
// recorded. Every assertion eventually flows through `capture()` (ANSI-
// stripped text) or `captureRaw()` (escape sequences preserved). The
// `waitForText` / `waitFor` polling lives here so individual tests do not
// re-implement timing loops — flaky timing belongs in one place.
//
// The pane id is resolved on every call via the supplied `resolvePaneId`
// closure. Production tmux-host calls `swap-pane` to move hidden source
// panes into the visible right slot whenever a step starts; that operation
// changes the pane id occupying the visible position. A handle that froze
// its pane id at mount time would silently end up capturing the scratch
// pane after the first swap. Re-resolving each call keeps the handle
// pointing at "the pane the user is currently looking at".

import type { PaneId, SocketName, TmuxService } from '../../../src/services/tmux/index.ts'
import { stripAnsi } from './ansi.ts'

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_INTERVAL_MS = 50

export interface PaneHandle {
  /** Pane id (`%N`) at the moment of the call. Changes after `swap-pane`. */
  readonly paneId: Promise<PaneId>
  /** ANSI-stripped pane contents. */
  capture(): Promise<string>
  /** Pane contents with escape sequences intact. */
  captureRaw(): Promise<string>
  /**
   * Resolves when `capture()` contains `needle`. Rejects with an error
   * containing the last captured frame if `timeoutMs` elapses first.
   */
  waitForText(needle: string, opts?: WaitOptions): Promise<void>
  /**
   * Resolves when `predicate(capture())` first returns true. Rejects with an
   * error containing the last captured frame if `timeoutMs` elapses first.
   */
  waitFor(predicate: (text: string) => boolean, opts?: WaitOptions): Promise<void>
}

export interface WaitOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

export interface CreatePaneHandleDeps {
  readonly tmux: TmuxService
  readonly socket: SocketName
  /**
   * Resolver called on every capture/waitFor. Returns the pane id currently
   * occupying the slot this handle represents. For the right-pane handle, the
   * resolver re-queries listPanes; for the left handle it can return a fixed
   * id because tmux-host never swaps the left pane.
   */
  readonly resolvePaneId: () => Promise<PaneId>
  /** Tag surfaces in waitForText error messages so failures point at the right pane. */
  readonly label?: string
}

export function createPaneHandle(deps: CreatePaneHandleDeps): PaneHandle {
  const label = deps.label ?? 'pane'

  const captureRaw = async (): Promise<string> => {
    const target = await deps.resolvePaneId()
    return deps.tmux.capturePane({
      socket: deps.socket,
      target,
      escapeCodes: true,
      joinWrapped: true,
    })
  }

  const capture = async (): Promise<string> => {
    const target = await deps.resolvePaneId()
    const raw = await deps.tmux.capturePane({
      socket: deps.socket,
      target,
      joinWrapped: true,
    })
    return stripAnsi(raw)
  }

  const waitFor = async (
    predicate: (text: string) => boolean,
    opts: WaitOptions = {},
  ): Promise<void> => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const deadline = Date.now() + timeoutMs

    let lastFrame = ''
    while (Date.now() < deadline) {
      lastFrame = await capture()
      if (predicate(lastFrame)) return
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    lastFrame = await capture()
    if (predicate(lastFrame)) return

    throw new Error(
      `waitFor(${label}): predicate did not match within ${timeoutMs}ms.\n` +
        `Last captured frame:\n${lastFrame}`,
    )
  }

  const waitForText = async (needle: string, opts?: WaitOptions): Promise<void> => {
    try {
      await waitFor((text) => text.includes(needle), opts)
    } catch {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const lastFrame = await capture()
      throw new Error(
        `waitForText(${label}, ${JSON.stringify(needle)}): not found within ${timeoutMs}ms.\n` +
          `Last captured frame:\n${lastFrame}`,
      )
    }
  }

  return {
    get paneId(): Promise<PaneId> {
      return deps.resolvePaneId()
    },
    capture,
    captureRaw,
    waitForText,
    waitFor,
  }
}
