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
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type {
  CommandLine,
  ForegroundShutdownReason,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { renderFailureText } from './failure-text.ts'
import { createPerStepTee } from './per-step-tee.ts'
import { renderTranscriptLine } from './render-line.ts'

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

  const tee = createPerStepTee(opts.logger)

  const writeJsonLine = (payload: Record<string, unknown>): void => {
    const envelope: Record<string, unknown> = {
      ts: new Date(opts.clock.now()).toISOString(),
      run: opts.runId,
      ...payload,
    }
    opts.stdout.write(`${JSON.stringify(envelope)}\n`)
  }

  // `kind: 'line'` lines get the `[<step>] ` prefix; `kind: 'block'` lines
  // are step-anchored by the heading itself, so no prefix. Color is on only
  // for TTY stdout without NO_COLOR (pipes and CI tails stay plain).
  const color = (opts.stdout as { isTTY?: boolean }).isTTY === true && !process.env.NO_COLOR

  const onRunnerEvent = (
    event: RunnerEvent,
    step: StepName,
    lines: readonly TranscriptLine[],
  ): void => {
    if (opts.format === 'json') {
      writeJsonLine({ ev: 'event', step, kind: event.kind, type: event.type, ...payloadOf(event) })
      return
    }
    if (lines.length === 0) return
    const prefix = `[${step}] `
    let teeBuf = ''
    for (const line of lines) {
      const rendered = renderTranscriptLine(line, {
        color,
        prefix: line.kind === 'line' ? prefix : '',
      })
      for (const out of rendered) {
        const wire = `${out}\n`
        opts.stdout.write(wire)
        teeBuf += wire
      }
    }
    // One tee write per event keeps the per-step file's line ordering
    // identical to the bytes the user saw on stdout.
    if (teeBuf.length > 0) tee.write(step, teeBuf)
  }

  const onCommandLine = ({ stream, line, step, pane: _pane }: CommandLine): void => {
    if (opts.format === 'json') {
      writeJsonLine({ ev: 'command-line', step, stream, line })
      return
    }
    const sink = stream === 'stderr' ? opts.stderr : opts.stdout
    sink.write(`[${step}] ${line}\n`)
  }

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    // Manage the per-step formatted_output.* sinks alongside any text/json
    // bytes the host emits. The tee opens before the first onRunnerEvent
    // because step:start fires before any runner event.
    if (event.type === 'step:start' && event.mode === 'autonomous') {
      tee.open(event.stepName)
    } else if (event.type === 'step:complete' || event.type === 'step:failed') {
      tee.close(event.stepName)
    }

    if (opts.format === 'json') {
      writeJsonLine(jsonLifecycle(event))
      return
    }
    // U6 R16 — `textLifecycle` returns the empty string for sub events that
    // should be suppressed in the active rendering mode (parallel-branch
    // divider suppression). Skip the line in that case rather than writing
    // a bare `[orch] ` row.
    const line = textLifecycle(event)
    if (line === '') return
    opts.stdout.write(`[orch] ${line}\n`)
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

  const awaitForegroundShutdown = async (): Promise<ForegroundShutdownReason> => {
    // Plain mode has no foreground UI and no quit-intent vector. The
    // workflow promise drives shutdown; this signal resolves immediately
    // with `'attach-exited'` so the CLI never takes the quit branch.
    return 'attach-exited'
  }

  const teardown = async (): Promise<void> => {
    // Drain any per-step formatted_output sinks left open by SIGINT mid-step
    // so the partial bytes hit disk before the run-ended record.
    await tee.drain()
    void opts.logger?.append('lifecycle', { type: 'host-torndown', mode }).catch(() => {})
    orchLog(opts.logger, 'host-teardown', { mode })
    /* plain writes are synchronous; nothing to flush. */
  }

  const probeReachability = async (): Promise<{ reachable: true }> => {
    /* plain has no backing surface that can vanish; always reachable. */
    return { reachable: true }
  }

  return {
    mode,
    writeBanner,
    onRunnerEvent,
    onLifecycleEvent,
    onCommandLine,
    attach,
    runInteractive,
    attachForeground,
    awaitForegroundShutdown,
    probeReachability,
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
    case 'step:parallel-start':
    case 'step:parallel-complete':
      return `${event.type} [block ${event.blockId}]`
    case 'subworkflow:enter':
      // U6 R16 — suppress the divider inside parallel composition. Sequential
      // composition renders a one-line boundary so the user can see where the
      // sub starts and ends.
      if (event.insideParallel === true) return ''
      return `── ▶ subworkflow[${event.depth}]: ${event.name} ──`
    case 'subworkflow:exit': {
      if (event.insideParallel === true) return ''
      const tag = event.outcome === 'completed' ? '◀' : '✗'
      return `── ${tag} subworkflow[${event.depth}]: ${event.name} (${event.durationMs}ms) ──`
    }
    case 'host-error':
      return `── ! host-error on ${event.source} for ${event.name}: ${event.message} ──`
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
    case 'step:parallel-start':
      return { ev: 'step.parallel-start', blockId: event.blockId }
    case 'step:parallel-complete':
      return { ev: 'step.parallel-complete', blockId: event.blockId }
    case 'subworkflow:enter':
      return {
        ev: 'subworkflow.enter',
        name: event.name,
        depth: event.depth,
        ...(event.insideParallel === true ? { insideParallel: true } : {}),
      }
    case 'subworkflow:exit':
      return {
        ev: 'subworkflow.exit',
        name: event.name,
        depth: event.depth,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.insideParallel === true ? { insideParallel: true } : {}),
      }
    case 'host-error':
      return {
        ev: 'host-error',
        source: event.source,
        name: event.name,
        depth: event.depth,
        message: event.message,
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
