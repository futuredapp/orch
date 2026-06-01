// ---------------------------------------------------------------------------
// StepsViewModel — composing factory: tailers + projector + emitter.
// ---------------------------------------------------------------------------
//
// No React, no Ink, no transcript reads at projection time. The model layers a
// live overlay (derived from `<stateDir>/logs/lifecycle.ndjson`) on top of the
// persisted `<stateDir>/state.json` so the UI sees currently-running steps
// before they hit disk. Every change to either file re-projects.
//
// Pure types live in `step-types.ts`. The pure projector lives in
// `project-steps-view.ts`. The lifecycle-event folder lives in
// `live-overlay.ts`. This file is the composition root only.

import { EventEmitter } from 'node:events'
import type { FsService } from '../../../services/fs/index.ts'
import type { Path } from '../../../services/types.ts'
import { path as toPath } from '../../../services/types.ts'
import type { RunId, RunState, StateStore } from '../../../state/index.ts'
import {
  applyLifecycleEvent,
  applySubworkflowEvent,
  type LiveOverlay,
  type SubworkflowOverlay,
} from './live-overlay.ts'
import { projectStepsView } from './project-steps-view.ts'
import type { StepsViewState } from './step-types.ts'
import { type TailNdjsonHandle, tailNdjson } from './tail-ndjson.ts'
import { type TailStateJsonHandle, tailStateJson } from './tail-state-json.ts'
import { DEFAULT_TUI_OVERLAY, parseTuiOverlayLine, type TuiOverlay } from './tui-overlay.ts'

export interface CreateStepsViewModelOptions {
  readonly stateDir: Path
  readonly workflowName: string
  readonly fs: FsService
  readonly stateStore: StateStore
  readonly runId: RunId
  readonly clock: { readonly now: () => number }
}

export interface StepsViewModel {
  /** Latest state, or `undefined` until the first projection has fired. */
  state(): StepsViewState | undefined
  on(event: 'change', handler: (state: StepsViewState) => void): void
  off(event: 'change', handler: (state: StepsViewState) => void): void
  /** Begin tailing files. Resolves once the initial projection has emitted. */
  start(): Promise<void>
  /** Stop tailers. Idempotent. Future change events are silenced. */
  stop(): Promise<void>
}

export function createStepsViewModel(opts: CreateStepsViewModelOptions): StepsViewModel {
  const emitter = new EventEmitter()
  const overlay = new Map<string, LiveOverlay>()
  const subOverlay = new Map<string, SubworkflowOverlay>()
  let tuiOverlay: TuiOverlay = DEFAULT_TUI_OVERLAY
  let latest: StepsViewState | undefined
  let currentRun: RunState | undefined
  let stateTail: TailStateJsonHandle | undefined
  let lifecycleTail: TailNdjsonHandle | undefined
  let tuiOverlayTail: TailNdjsonHandle | undefined
  let stopped = false

  const reproject = (): void => {
    if (stopped) return
    const next = projectStepsView({
      run: currentRun,
      overlay,
      subOverlay,
      workflowName: opts.workflowName,
      runIdFallback: opts.runId,
      view: tuiOverlay.view,
      ...(tuiOverlay.banner !== undefined ? { banner: tuiOverlay.banner } : {}),
    })
    latest = next
    emitter.emit('change', next)
  }

  const reloadState = async (): Promise<void> => {
    try {
      currentRun = await opts.stateStore.loadRun(opts.runId)
    } catch {
      // Schema corruption — keep last good state; the next write will retry.
      return
    }
    reproject()
  }

  const start = async (): Promise<void> => {
    if (stopped) return
    stateTail = tailStateJson({
      filePath: toPath(`${opts.stateDir}/state.json`),
      onChange: () => {
        void reloadState()
      },
    })
    lifecycleTail = tailNdjson({
      filePath: toPath(`${opts.stateDir}/logs/lifecycle.ndjson`),
      fs: opts.fs,
      onLine: (raw) => {
        try {
          const parsed = JSON.parse(raw) as {
            readonly type?: string
            readonly stepName?: string
            readonly mode?: string
            readonly name?: string
            readonly depth?: number
            readonly durationMs?: number
            readonly outcome?: 'completed' | 'failed'
            readonly insideParallel?: true
          }
          if (typeof parsed.type !== 'string') return
          const now = opts.clock.now()
          applyLifecycleEvent(
            overlay,
            { type: parsed.type, stepName: parsed.stepName, mode: parsed.mode },
            now,
          )
          applySubworkflowEvent(
            subOverlay,
            {
              type: parsed.type,
              name: parsed.name,
              depth: parsed.depth,
              durationMs: parsed.durationMs,
              outcome: parsed.outcome,
              insideParallel: parsed.insideParallel,
            },
            now,
          )
          reproject()
        } catch {
          // malformed line — ignore
        }
      },
    })
    tuiOverlayTail = tailNdjson({
      filePath: toPath(`${opts.stateDir}/tui-overlay.ndjson`),
      fs: opts.fs,
      onLine: (raw) => {
        const next = parseTuiOverlayLine(raw)
        if (next === undefined) return
        tuiOverlay = next
        reproject()
      },
    })
    await stateTail.start()
    await lifecycleTail.start()
    await tuiOverlayTail.start()
    if (latest === undefined) reproject()
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (stateTail !== undefined) await stateTail.stop()
    if (lifecycleTail !== undefined) await lifecycleTail.stop()
    if (tuiOverlayTail !== undefined) await tuiOverlayTail.stop()
    emitter.removeAllListeners()
  }

  return {
    state: () => latest,
    on: (event, handler) => {
      emitter.on(event, handler)
    },
    off: (event, handler) => {
      emitter.off(event, handler)
    },
    start,
    stop,
  }
}

export type { LiveOverlay, SubworkflowOverlay } from './live-overlay.ts'
// Public re-exports — callers import from the barrel which re-exports from
// here, so existing imports stay source-compatible after the split.
export { applyLifecycleEvent, applySubworkflowEvent } from './live-overlay.ts'
export type { ProjectArgs } from './project-steps-view.ts'
export { projectStepsView } from './project-steps-view.ts'
export type {
  Banner,
  EndOfRunSummary,
  RunHeader,
  StepRow,
  StepStatus,
  StepsViewState,
  ViewMode,
} from './step-types.ts'
export type { TuiOverlay, TuiOverlaySnapshot } from './tui-overlay.ts'
export {
  DEFAULT_TUI_OVERLAY,
  parseTuiOverlayLine,
  serializeTuiOverlayLine,
} from './tui-overlay.ts'
