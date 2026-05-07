// ---------------------------------------------------------------------------
// executeWithAttach — race the workflow promise against host shutdown signals.
// ---------------------------------------------------------------------------
//
// Shared between `run` and `resume`. The race composes two separate signals:
//
//   - `attachForeground()`        — the foreground attach client. In two-pane
//                                   it spawns `tmux attach-session`; resolves
//                                   when the user detaches or the session
//                                   dies. Plain mode resolves immediately.
//   - `awaitForegroundShutdown()` — Phase 4 signal: resolves on the first of
//                                   `attachForeground exits | quitIntent`.
//                                   The TUI stays mounted past workflow
//                                   completion; this signal is what tells
//                                   the CLI the user is done with it.
//
// Race shape:
//   - Workflow finishes first  → in two-pane the TUI stays mounted with the
//     end-of-run summary; we wait for `awaitForegroundShutdown` before
//     teardown so the user can review. Plain mode resolves immediately.
//   - Foreground shutdown first → user pressed `q` or detached. Print the
//     detached hint, then wait for the workflow to finish silently before
//     teardown.

import type { Host } from '../../hosts/index.ts'
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import { EXIT } from '../main.ts'

const FOREGROUND_SETTLED = Symbol('foreground-settled')

// Hard cap on teardown during signal-triggered exit. tmux commands can
// occasionally hang (socket gone mid-command); we don't want a stuck process
// holding the user's terminal forever. Beyond this, we force-exit.
const SIGNAL_TEARDOWN_GRACE_MS = 2_000

export interface RunSummaryDescriptor {
  readonly workflowName: string
  /** Already-formatted relative path, e.g. `.orch/state/r-...-7k`. */
  readonly runDir: string
}

export interface ExecuteWithAttachOpts {
  readonly host: Host
  readonly workflow: Promise<void>
  readonly runId: string
  readonly stderr: NodeJS.WritableStream
  /** Maps domain errors to an exit code AND a reason string the failure
   *  summary can quote. Returning `undefined` means re-throw unchanged. */
  readonly mapError: (err: unknown) => { code: number; reason: string } | undefined
  /** Workflow name + run dir used to render the end-of-run summary block on
   *  both the success and mapped-failure paths. */
  readonly summary: RunSummaryDescriptor
  /** Optional per-run logger for `--debug` orch.log entries. */
  readonly logger?: SessionLogger
}

export async function executeWithAttach(opts: ExecuteWithAttachOpts): Promise<number> {
  // Signal handlers: Ctrl-C / SIGTERM during attach would otherwise kill orch
  // mid-race and leave the tmux session alive with mouse-tracking bits on the
  // outer TTY. Route them through teardown (idempotent) before exiting.
  // Scoped to this function and unregistered in `finally` so repeat
  // invocations (tests, `orch resume` after `orch run`) don't stack handlers.
  const makeSignalHandler = (code: number) => (): void => {
    orchLog(opts.logger, 'signal-received', { exitCode: code })
    // Fire-and-forget: signal handlers cannot await. The `.finally` exits
    // either way — a teardown failure still unblocks the TTY.
    void opts.host.teardown().finally(() => process.exit(code))
    // Hard cap: if teardown hangs (tmux socket gone mid-command) we still
    // exit. `unref` so a fast teardown doesn't keep the loop alive.
    setTimeout(() => process.exit(code), SIGNAL_TEARDOWN_GRACE_MS).unref()
  }
  const sigintHandler = makeSignalHandler(EXIT.SIGINT)
  const sigtermHandler = makeSignalHandler(EXIT.SIGTERM)
  // Treat SIGHUP as SIGTERM — same blast radius, same exit code semantics.
  const sighupHandler = makeSignalHandler(EXIT.SIGTERM)
  process.on('SIGINT', sigintHandler)
  process.on('SIGTERM', sigtermHandler)
  process.on('SIGHUP', sighupHandler)

  let workflowSettled = false
  const trackedWorkflow = opts.workflow.finally(() => {
    workflowSettled = true
  })

  // Kick off the foreground attach. We don't race directly against the
  // attach promise anymore — `awaitForegroundShutdown` is the composed signal
  // that includes both the attach exit and the user's quit intent. The
  // attach call still has to be made: under two-pane it spawns the tmux
  // attach client which gives the user the TUI.
  void opts.host.attachForeground().catch(() => {
    /* swallow: attachForeground never throws today, and even if it did the
       awaitForegroundShutdown signal would still resolve through its other
       branch (quit intent). */
  })

  // Swallow into the symbol so callers don't have to disambiguate by promise
  // identity — race-winner check is the symbol vs. void return.
  const foregroundShutdown = opts.host
    .awaitForegroundShutdown()
    .then(() => FOREGROUND_SETTLED)
    .catch(() => FOREGROUND_SETTLED)

  try {
    const winner = await Promise.race([trackedWorkflow, foregroundShutdown])

    if (winner === FOREGROUND_SETTLED && !workflowSettled && opts.host.mode === 'two-pane') {
      opts.stderr.write(
        `[orch] detached. run continues in background.\n` +
          `[orch] re-attach with: tmux -L orch-${opts.runId} attach -t orch\n` +
          `[orch] tail logs with: orch logs ${opts.runId}\n`,
      )
    }

    // Always wait on the workflow — even if the foreground signal won, the
    // workflow continues running in-process and carries the exit code.
    await trackedWorkflow

    // Two-pane only: workflow finished first. Keep the TUI mounted past
    // completion (it's now showing the end-of-run summary) until the user
    // dismisses it (q intent, or detach). Plain mode's
    // awaitForegroundShutdown resolves immediately so this is a no-op.
    if (winner !== FOREGROUND_SETTLED && opts.host.mode === 'two-pane') {
      await foregroundShutdown
    }
  } catch (err) {
    const mapped = opts.mapError(err)
    await opts.host.teardown()
    if (mapped !== undefined) {
      writeFailureSummary(opts.stderr, opts.summary, mapped.reason)
      return mapped.code
    }
    throw err
  } finally {
    process.off('SIGINT', sigintHandler)
    process.off('SIGTERM', sigtermHandler)
    process.off('SIGHUP', sighupHandler)
  }

  await opts.host.teardown()
  writeSuccessSummary(opts.stderr, opts.summary)
  return EXIT.OK
}

function writeSuccessSummary(stderr: NodeJS.WritableStream, summary: RunSummaryDescriptor): void {
  stderr.write(`Workflow "${summary.workflowName}" completed.\n  data: ${summary.runDir}/\n`)
}

function writeFailureSummary(
  stderr: NodeJS.WritableStream,
  summary: RunSummaryDescriptor,
  reason: string,
): void {
  stderr.write(`Workflow "${summary.workflowName}" failed: ${reason}\n  data: ${summary.runDir}/\n`)
}
