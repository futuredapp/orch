// ---------------------------------------------------------------------------
// Live overlay — derived from `lifecycle.ndjson` tail.
// ---------------------------------------------------------------------------
//
// Each lifecycle line is `{ type: 'step:start' | ..., stepName, ... }`. We
// fold them into a per-stepName overlay; later events overwrite earlier ones.
// The projector layers this overlay on top of the persisted RunState.steps so
// the UI shows currently-running steps before they hit disk.

import type { StepStatus } from './step-types.ts'

export interface LiveOverlay {
  readonly status: StepStatus
  readonly mode?: 'interactive' | 'autonomous'
  readonly startedAt?: number
  readonly endedAt?: number
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
    case 'step:complete': {
      overlay.set(name, {
        status: 'completed',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
        ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        endedAt: now,
      })
      return
    }
    case 'step:failed': {
      overlay.set(name, {
        status: 'failed',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
        ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        endedAt: now,
      })
      return
    }
    case 'step:cached': {
      overlay.set(name, {
        status: 'cached',
        ...(previous?.mode !== undefined ? { mode: previous.mode } : {}),
      })
      return
    }
    default:
      return
  }
}
