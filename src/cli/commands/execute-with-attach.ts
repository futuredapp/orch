// ---------------------------------------------------------------------------
// executeWithAttach — race the workflow promise against host.attachForeground.
// ---------------------------------------------------------------------------
//
// Shared between `run` and `resume`. Whichever promise settles first drives
// the teardown sequence:
//
//   - Workflow first → teardown kills the tmux session → attach client exits.
//   - Attach first (user `Ctrl-b d`) → print detached hint, wait for the
//     workflow to finish silently, then teardown.
//
// PlainHost's `attachForeground` resolves immediately, so the race collapses
// to "wait for the workflow" and the detached-hint branch is dead code under
// --mode=plain. It stays live under two-pane auto-attach, which is the only
// mode that can detach.

import type { Host } from '../../hosts/index.ts'
import { EXIT } from '../main.ts'

const ATTACH_SETTLED = Symbol('attach-settled')

// Hard cap on teardown during signal-triggered exit. tmux commands can
// occasionally hang (socket gone mid-command); we don't want a stuck process
// holding the user's terminal forever. Beyond this, we force-exit.
const SIGNAL_TEARDOWN_GRACE_MS = 2_000

export interface ExecuteWithAttachOpts {
  readonly host: Host
  readonly workflow: Promise<void>
  readonly runId: string
  readonly stderr: NodeJS.WritableStream
  /** Maps domain errors (StepError, ViewResolutionError, …) to exit codes. */
  readonly mapError: (err: unknown) => number | undefined
  /** Called on successful completion (before teardown returns to the caller). */
  readonly onSuccess: () => void
}

export async function executeWithAttach(opts: ExecuteWithAttachOpts): Promise<number> {
  // Signal handlers: Ctrl-C / SIGTERM during attach would otherwise kill orch
  // mid-race and leave the tmux session alive with mouse-tracking bits on the
  // outer TTY. Route them through teardown (idempotent) before exiting.
  // Scoped to this function and unregistered in `finally` so repeat
  // invocations (tests, `orch resume` after `orch run`) don't stack handlers.
  const makeSignalHandler = (code: number) => (): void => {
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

  // Swallow attach errors into the race winner — attachForeground never
  // throws in the current implementation, but if it did, we still want the
  // workflow to drive exit status.
  const attachRacer = opts.host
    .attachForeground()
    .then(() => ATTACH_SETTLED)
    .catch(() => ATTACH_SETTLED)

  try {
    const winner = await Promise.race([trackedWorkflow, attachRacer])

    if (winner === ATTACH_SETTLED && !workflowSettled && opts.host.mode === 'two-pane') {
      opts.stderr.write(
        `[orch] detached. run continues in background.\n` +
          `[orch] re-attach with: tmux -L orch-${opts.runId} attach -t orch\n` +
          `[orch] tail logs with: orch logs ${opts.runId}\n`,
      )
    }

    // Always wait on the workflow — even if the attach won the race, the
    // workflow continues running in-process and carries the exit code.
    await trackedWorkflow
  } catch (err) {
    const code = opts.mapError(err)
    await opts.host.teardown()
    if (code !== undefined) return code
    throw err
  } finally {
    process.off('SIGINT', sigintHandler)
    process.off('SIGTERM', sigtermHandler)
    process.off('SIGHUP', sighupHandler)
  }

  await opts.host.teardown()
  opts.onSuccess()
  return EXIT.OK
}
