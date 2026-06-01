// ---------------------------------------------------------------------------
// status-loop — bridges workflow lifecycle events to the tmux status pane
// ---------------------------------------------------------------------------
//
// The loop owns one bit of state (the live step map) and one side effect
// (writing rendered lines to a tmux pane). It exposes:
//
//   - `onStepEvent` — drop directly into `WorkflowDeps.onStepEvent`.
//   - `stop()` — called from the workflow `finally` block to stop rendering.
//   - `records()` — structured snapshot for agent consumers.
//
// Rendering is state-change driven: each event triggers one render. If a
// render is already in flight, the next event marks the loop dirty and
// re-renders on completion. Tmux errors are routed through `onError` so
// observability failures never bubble up into the workflow executor.

import type { StepLifecycleEvent } from '../core/workflow.ts'
import type { Clock } from '../services/clock/index.ts'
import type { PaneId, SocketName, TmuxService } from '../services/tmux/index.ts'
import { type RenderOptions, renderStatusPane, type StepStatusRecord } from './status-pane.ts'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface StatusLoopOptions {
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly target: PaneId
  readonly clock: Clock
  readonly tty?: boolean
  readonly runTitle?: string
  /** Tmux failures are routed here — default silently swallows. */
  readonly onError?: (error: unknown) => void
}

export interface StatusLoop {
  /** Feed step lifecycle events here — wire into `WorkflowDeps.onStepEvent`. */
  readonly onStepEvent: (event: StepLifecycleEvent) => void
  /**
   * Stop rendering. Idempotent. Further events are ignored. Does NOT kill
   * the tmux pane — lifecycle ownership stays with the caller.
   */
  readonly stop: () => void
  /** Current snapshot of status records (for tests, agents). */
  readonly records: () => readonly StepStatusRecord[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type LiveEntry = Omit<StepStatusRecord, 'name'>

// Screen clear + cursor home. Written as the first bytes of every render so
// the pane redraws cleanly without flicker-scrolling.
const CLEAR_SCREEN = '\u001b[2J\u001b[H'

export function startStatusLoop(opts: StatusLoopOptions): StatusLoop {
  const live = new Map<string, LiveEntry>()
  let stopped = false
  let rendering = false
  let dirty = false

  const renderOptions = (): RenderOptions => ({
    now: opts.clock.now(),
    ...(opts.tty !== undefined ? { tty: opts.tty } : {}),
    ...(opts.runTitle !== undefined ? { runTitle: opts.runTitle } : {}),
  })

  const recordsList = (): StepStatusRecord[] => {
    const list: StepStatusRecord[] = []
    for (const [name, entry] of live) list.push({ name, ...entry })
    return list
  }

  const flush = async (): Promise<void> => {
    if (stopped) return
    if (rendering) {
      dirty = true
      return
    }

    rendering = true
    try {
      do {
        dirty = false
        const lines = renderStatusPane(recordsList(), renderOptions())
        const payload = `${CLEAR_SCREEN}${lines.join('\r\n')}\r\n`
        try {
          await opts.tmux.sendKeys({
            socket: opts.socket,
            target: opts.target,
            keys: [payload],
          })
        } catch (error) {
          opts.onError?.(error)
          // Break out of the re-render loop — repeated sendKeys failures
          // would just spam onError. Next event will retry.
          dirty = false
        }
      } while (dirty && !stopped)
    } finally {
      rendering = false
    }
  }

  const handle = (event: StepLifecycleEvent): void => {
    if (stopped) return
    applyEvent(live, event, opts.clock.now())
    // Fire-and-forget — callers mustn't await observability.
    void flush()
  }

  return {
    onStepEvent: handle,
    stop: () => {
      stopped = true
    },
    records: recordsList,
  }
}

// ---------------------------------------------------------------------------
// Event application — pure. Extracted so tests can exercise state transitions
// without plumbing a full TmuxService.
// ---------------------------------------------------------------------------

export function applyEvent(
  live: Map<string, LiveEntry>,
  event: StepLifecycleEvent,
  now: number,
): void {
  // Block-scoped events carry a `blockId`, not a `stepName` — they don't
  // affect the per-step left-pane rollup. The two-pane host consumes them
  // directly via its `onLifecycleEvent` handler.
  if (event.type === 'step:parallel-start' || event.type === 'step:parallel-complete') {
    return
  }
  // U6 — subworkflow boundary events and host-error records carry no
  // `stepName` and do not affect the per-step status rollup. The two-pane
  // host consumes them via its own choreographer / steps-view model.
  if (
    event.type === 'subworkflow:enter' ||
    event.type === 'subworkflow:exit' ||
    event.type === 'host-error'
  ) {
    return
  }
  const name = event.stepName
  const previous = live.get(name)

  switch (event.type) {
    case 'step:start':
      live.set(name, {
        status: event.mode === 'interactive' ? 'interactive' : 'running',
        mode: event.mode,
        startedAt: now,
      })
      return

    case 'step:complete':
      live.set(name, {
        status: 'completed',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
        startedAt: previous?.startedAt ?? now - event.durationMs,
        endedAt: now,
      })
      return

    case 'step:failed':
      live.set(name, {
        status: 'failed',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
        ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        endedAt: now,
      })
      return

    case 'step:cached':
      live.set(name, {
        status: 'cached',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
      })
      return

    case 'step:parallel-branch-update':
      // The left pane's status rollup is driven by the companion step:start
      // / step:complete / step:failed events; the parallel-branch-update
      // exists for hosts that render a compact parallel rollup (two-pane).
      // Swallowing it here is intentional.
      return
  }
}
