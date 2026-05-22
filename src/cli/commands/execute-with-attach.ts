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
//   - `awaitForegroundShutdown()` — Phase 4 signal: resolves with a tagged
//                                   reason — `'quit'` (user pressed q /
//                                   Ctrl-C in the Ink pane) or
//                                   `'attach-exited'` (user detached, or
//                                   the tmux session died). Plain mode
//                                   always reports `'attach-exited'`.
//
// Race shape:
//   - Workflow finishes first   → in two-pane the TUI stays mounted with the
//     end-of-run summary; we wait for `awaitForegroundShutdown` before
//     teardown so the user can review. Plain mode resolves immediately.
//   - Foreground shutdown first → branch on the reason:
//     * `'quit'`          → user asked orch to stop. Tear the host down and
//                           exit with EXIT.SIGINT. Do NOT await the workflow
//                           (it may be held mid-step and would block forever).
//     * `'attach-exited'` → user detached cleanly. Print the re-attach hint,
//                           then wait for the workflow to finish in the
//                           background before tearing down.

import type { ForegroundShutdownReason, Host } from '../../hosts/index.ts'
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import { EXIT } from '../main.ts'

const FOREGROUND_SETTLED = Symbol('foreground-settled')

interface ForegroundSettledResult {
  readonly tag: typeof FOREGROUND_SETTLED
  readonly reason: ForegroundShutdownReason
}

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
  /**
   * `--no-attach`: orch never spawns a foreground `tmux attach-session`.
   * Tells the post-workflow await to short-circuit instead of hanging on a
   * foreground-shutdown signal that has no real attach to settle. Defaults
   * to `false`. Plain mode ignores this flag.
   */
  readonly skipAttach?: boolean
}

async function handleAttachExitedTwoPane(opts: ExecuteWithAttachOpts): Promise<void> {
  const reach = await opts.host.probeReachability()
  if (reach.reachable) {
    opts.stderr.write(
      `[orch] detached. run continues in background.\n` +
        `[orch] re-attach with: tmux -L orch-${opts.runId} attach -t orch\n` +
        `[orch] tail logs with: orch logs ${opts.runId}\n`,
    )
    return
  }
  // Don't print the detach hint. The workflow's next host call will throw
  // HostUnavailableError, which `mapError` translates into the standard
  // failure summary — we just need to not lie about a background
  // continuation that physically cannot happen.
  opts.stderr.write(
    `[orch] ${reach.reason ?? 'host is no longer reachable'} — workflow cannot continue in background.\n` +
      `[orch] data: ${opts.summary.runDir}/\n`,
  )
  orchLog(opts.logger, 'attach-exited-unreachable', {
    runId: opts.runId,
    reason: reach.reason ?? 'unknown',
  })
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

  // Wrap into a tagged result so the race winner check can pattern-match
  // both on identity (foreground vs workflow) and on reason (quit vs
  // attach-exited). The reason discriminator is what fixes the §2.1 /
  // attach-tty-ctrl-c bugs: a `quit` while a step is held must tear orch
  // down without awaiting the (forever-blocked) workflow.
  const foregroundShutdown: Promise<ForegroundSettledResult> = opts.host
    .awaitForegroundShutdown()
    .then((reason) => ({ tag: FOREGROUND_SETTLED, reason }) as const)
    .catch(() => ({ tag: FOREGROUND_SETTLED, reason: 'attach-exited' }) as const)

  try {
    const winner = await Promise.race([trackedWorkflow, foregroundShutdown])

    if (
      typeof winner === 'object' &&
      winner !== null &&
      'tag' in winner &&
      winner.tag === FOREGROUND_SETTLED &&
      !workflowSettled
    ) {
      // User-quit branch: the workflow is still running (potentially held
      // mid-step). Awaiting it would block forever. Tear orch down and
      // exit through the same code path as a SIGINT — this is the fix for
      // the §2.1 (`q`) and `attach-tty-ctrl-c` bugs.
      if (winner.reason === 'quit') {
        orchLog(opts.logger, 'foreground-quit', { runId: opts.runId })
        await opts.host.teardown()
        return EXIT.SIGINT
      }

      // Attach-exited branch: the foreground attach client went away. Two
      // very different causes look identical here:
      //   1. User cleanly detached (prefix-d). tmux server is alive; the
      //      workflow CAN keep running in the background. Print the
      //      re-attach hint.
      //   2. tmux server died externally (incident r-2026-05-22-093650-j0):
      //      attach client exited because the server vanished. The workflow
      //      CANNOT continue — the next interactive step has nowhere to
      //      spawn. Printing the re-attach hint would actively mislead the
      //      user. Surface the failure path instead.
      if (opts.host.mode === 'two-pane') {
        await handleAttachExitedTwoPane(opts)
      }
    }

    // Always wait on the workflow — even if the foreground signal won
    // (attach-exited branch), the workflow continues running in-process and
    // carries the exit code. The quit branch above returned early and
    // never reaches this await.
    await trackedWorkflow

    // Two-pane only: workflow finished first. Keep the TUI mounted past
    // completion (it's now showing the end-of-run summary) until the user
    // dismisses it (q intent, or detach). Plain mode's
    // awaitForegroundShutdown resolves immediately so this is a no-op.
    // `--no-attach` mode also skips this await: there is no real TUI for
    // the user to dismiss, and the foreground signal would never settle
    // (no attach client to exit, no quit intent forthcoming).
    const isForegroundResult = typeof winner === 'object' && winner !== null && 'tag' in winner
    if (!isForegroundResult && opts.host.mode === 'two-pane' && opts.skipAttach !== true) {
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
