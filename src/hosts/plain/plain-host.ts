// ---------------------------------------------------------------------------
// PlainHost — the `--mode=plain` implementation of the Host port.
// ---------------------------------------------------------------------------
//
// `text` format: one prefixed line per event. `[orch] …` for lifecycle,
// `[<step>] …` for runner events. Matches Story 2 / Mode 1 in the plan.
//
// `json` format: one NDJSON envelope per event. Flat shape
//     { ts, run, ev, step, …payload }
// for fast discrimination without payload parse (see plan's "Research Insights
// (Phase A)" for rationale). No banner is emitted on stdout under `json`; the
// banner still goes to stderr.

import type { RunMode } from '../../core/run-mode.ts'
import type { RunId, StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import type { RunnerEvent } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { Host, PaneAttachment, PaneRole } from '../host.ts'
import { renderTranscriptLine } from './transcript-text.ts'

export type PlainFormat = 'text' | 'json'

export interface PlainHostOptions {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly format: PlainFormat
  readonly clock: Clock
  readonly runId: RunId
}

export function createPlainHost(opts: PlainHostOptions): Host {
  const mode: RunMode = 'plain'

  const writeJsonLine = (payload: Record<string, unknown>): void => {
    const envelope: Record<string, unknown> = {
      ts: new Date(opts.clock.now()).toISOString(),
      run: opts.runId,
      ...payload,
    }
    opts.stdout.write(`${JSON.stringify(envelope)}\n`)
  }

  const onRunnerEvent = (event: RunnerEvent, step: StepName): void => {
    if (opts.format === 'json') {
      writeJsonLine({ ev: 'event', step, kind: event.kind, type: event.type, ...payloadOf(event) })
      return
    }
    const line = renderTranscriptLine(event)
    if (line === null) return
    opts.stdout.write(`[${step}] ${line}\n`)
  }

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    if (opts.format === 'json') {
      writeJsonLine(jsonLifecycle(event))
      return
    }
    opts.stdout.write(`[orch] ${textLifecycle(event)}\n`)
  }

  const writeBanner = (line: string): void => {
    if (opts.format === 'json') return // JSON consumers get nothing on stdout
    opts.stderr.write(`${line}\n`)
  }

  const attach = async (pane: PaneRole): Promise<PaneAttachment> => ({
    pane,
    async detach(): Promise<void> {
      /* plain host owns no panes */
    },
  })

  const teardown = async (): Promise<void> => {
    /* plain writes are synchronous; nothing to flush. */
  }

  return { mode, writeBanner, onRunnerEvent, onLifecycleEvent, attach, teardown }
}

function textLifecycle(event: StepLifecycleEvent): string {
  switch (event.type) {
    case 'step:start':
      return `${event.type} ${event.stepName} (${event.mode})`
    case 'step:complete':
      return `${event.type} ${event.stepName} (${event.durationMs}ms)`
    case 'step:failed':
      return `${event.type} ${event.stepName}: ${formatError(event.error)}`
    case 'step:cached':
      return `${event.type} ${event.stepName}`
  }
}

function jsonLifecycle(event: StepLifecycleEvent): Record<string, unknown> {
  switch (event.type) {
    case 'step:start':
      return { ev: 'step.start', step: event.stepName, mode: event.mode }
    case 'step:complete':
      return { ev: 'step.complete', step: event.stepName, durationMs: event.durationMs }
    case 'step:failed':
      return { ev: 'step.failed', step: event.stepName, error: formatError(event.error) }
    case 'step:cached':
      return { ev: 'step.cached', step: event.stepName }
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function payloadOf(event: RunnerEvent): Record<string, unknown> {
  if (event.kind === 'terminal') {
    if (event.type === 'error') return { message: event.message, data: event.data ?? null }
    return { data: event.data ?? null }
  }
  return event.payload === undefined ? {} : { payload: event.payload }
}
