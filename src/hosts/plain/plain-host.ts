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

import { summarizeFailure } from '../../core/failure-summary.ts'
import type { RunMode } from '../../core/run-mode.ts'
import type { RunId, StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import type { SessionLogger } from '../../observability/index.ts'
import type { RunnerEvent } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type {
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { renderFailureText } from './failure-text.ts'
import { renderTranscriptLine } from './transcript-text.ts'

export type PlainFormat = 'text' | 'json'

export interface PlainHostOptions {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly format: PlainFormat
  readonly clock: Clock
  readonly runId: RunId
  /**
   * Needed only for `runInteractive` (interactive steps under `--mode=plain`).
   * Other host methods never reach for it. The CLI wiring always passes it;
   * kept optional so tests that only exercise text/JSON output can omit it.
   */
  readonly processService?: ProcessService
  /**
   * Optional session logger. When present, emits `host-created` on
   * construction and `host-torndown` on teardown to `lifecycle.ndjson`.
   * Plain host has no tmux pane lifecycle; step-level lifecycle already
   * flows through the executor's logger tee.
   */
  readonly logger?: SessionLogger
}

export function createPlainHost(opts: PlainHostOptions): Host {
  const mode: RunMode = 'plain'

  void opts.logger?.append('lifecycle', { type: 'host-created', mode }).catch(() => {})

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
    // Story 1.5 frame follows the step:failed line on stderr so TTY users see
    // the copy-paste resume/logs hints immediately. JSON consumers get the
    // same info via the structured `ev: step.failed` envelope.
    if (event.type === 'step:failed') {
      const summary = summarizeFailure({
        stepName: event.stepName,
        runId: opts.runId,
        error: event.error,
        failedAt: opts.clock.now(),
      })
      opts.stderr.write(renderFailureText(summary))
    }
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

  const runInteractive = async (spawn: InteractiveSpawn): Promise<InteractiveResult> => {
    if (opts.processService === undefined) {
      throw new Error(
        `PlainHost: cannot run interactive step "${spawn.stepName}" without processService`,
      )
    }
    const startedAt = opts.clock.now()
    const handle = opts.processService.spawnForeground({
      argv: spawn.argv,
      env: spawn.env,
      cwd: spawn.cwd,
    })
    const { exitCode } = await handle.wait()
    return { exitCode, durationMs: opts.clock.now() - startedAt }
  }

  const attachForeground = async (): Promise<void> => {
    /* plain never takes the TTY — the workflow stream IS the foreground. */
  }

  const teardown = async (): Promise<void> => {
    void opts.logger?.append('lifecycle', { type: 'host-torndown', mode }).catch(() => {})
    /* plain writes are synchronous; nothing to flush. */
  }

  return {
    mode,
    writeBanner,
    onRunnerEvent,
    onLifecycleEvent,
    attach,
    runInteractive,
    attachForeground,
    teardown,
  }
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
    case 'step:parallel-branch-update':
      return `${event.type} ${event.stepName} [${event.branchStatus}]`
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
    case 'step:parallel-branch-update':
      return {
        ev: 'step.parallel-branch-update',
        step: event.stepName,
        branchStatus: event.branchStatus,
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
        ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
      }
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
