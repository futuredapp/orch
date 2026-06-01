// ---------------------------------------------------------------------------
// Live overlay — derived from `lifecycle.ndjson` tail.
// ---------------------------------------------------------------------------
//
// Each lifecycle line is `{ type: 'step:start' | ..., stepName, ... }`. We
// fold them into a per-stepName overlay; later events overwrite earlier ones.
// The projector layers this overlay on top of the persisted RunState.steps so
// the UI shows currently-running steps before they hit disk.
//
// `subworkflow:enter` / `subworkflow:exit` are folded into a SEPARATE overlay
// keyed by sub name (sub names cannot collide with step names per R20 in v1).
// The projector reads it to render boundary rows for in-flight subs that have
// no child step yet, and to mark exit rows for any sub that exited.

import type { StepStatus } from './step-types.ts'

export interface LiveOverlay {
  readonly status: StepStatus
  readonly mode?: 'interactive' | 'autonomous'
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface SubworkflowOverlay {
  readonly status: 'running' | 'completed' | 'failed'
  readonly depth: number
  /**
   * True when this sub ran inside (or transitively inside) a `parallel()`
   * branch. The projector uses it to suppress boundary rendering uniformly
   * across the whole sub subtree (R23 / AE13).
   */
  readonly insideParallel?: true
  readonly startedAt: number
  readonly endedAt?: number
  /** Carried from the `subworkflow:exit` event; absent until the sub exits. */
  readonly durationMs?: number
}

// step:complete and step:failed are structurally identical bar the status:
// both carry over the prior mode/startedAt and stamp endedAt. Extracted to
// keep applyLifecycleEvent under the rule-5 cognitive-complexity budget.
function terminalOverlay(
  status: 'completed' | 'failed',
  previous: LiveOverlay | undefined,
  now: number,
): LiveOverlay {
  return {
    status,
    ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
    ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
    endedAt: now,
  }
}

export function applyLifecycleEvent(
  overlay: Map<string, LiveOverlay>,
  event: { readonly type: string; readonly stepName?: string; readonly mode?: string },
  now: number,
): void {
  const name = event.stepName
  if (typeof name !== 'string' || name.length === 0) return
  const previous = overlay.get(name)
  switch (event.type) {
    case 'step:start': {
      const mode: 'interactive' | 'autonomous' | undefined =
        event.mode === 'interactive' || event.mode === 'autonomous' ? event.mode : undefined
      overlay.set(name, {
        status: mode === 'interactive' ? 'interactive' : 'running',
        ...(mode !== undefined ? { mode } : {}),
        startedAt: now,
      })
      return
    }
    case 'step:complete':
      overlay.set(name, terminalOverlay('completed', previous, now))
      return
    case 'step:failed':
      overlay.set(name, terminalOverlay('failed', previous, now))
      return
    case 'step:cached':
      overlay.set(name, {
        status: 'cached',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
      })
      return
    default:
      return
  }
}

export interface SubworkflowEvent {
  readonly type: string
  readonly name?: string
  readonly depth?: number
  readonly durationMs?: number
  readonly outcome?: 'completed' | 'failed'
  readonly insideParallel?: true
}

export function applySubworkflowEvent(
  overlay: Map<string, SubworkflowOverlay>,
  event: SubworkflowEvent,
  now: number,
): void {
  if (event.type !== 'subworkflow:enter' && event.type !== 'subworkflow:exit') return
  const name = event.name
  if (typeof name !== 'string' || name.length === 0) return
  const depth = event.depth
  if (typeof depth !== 'number' || depth <= 0) return

  if (event.type === 'subworkflow:enter') {
    overlay.set(name, {
      status: 'running',
      depth,
      ...(event.insideParallel === true ? { insideParallel: true } : {}),
      startedAt: now,
    })
    return
  }

  const previous = overlay.get(name)
  const status: 'completed' | 'failed' = event.outcome === 'failed' ? 'failed' : 'completed'
  overlay.set(name, {
    status,
    depth,
    ...(previous?.insideParallel === true || event.insideParallel === true
      ? { insideParallel: true as const }
      : {}),
    startedAt: previous?.startedAt ?? now,
    endedAt: now,
    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
  })
}
