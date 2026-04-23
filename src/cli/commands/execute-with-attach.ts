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
  }

  await opts.host.teardown()
  opts.onSuccess()
  return EXIT.OK
}
