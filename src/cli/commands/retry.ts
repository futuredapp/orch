// ---------------------------------------------------------------------------
// retry — `orch retry <id>` = `orch resume <id>` + auto retry-and-continue (U8).
// ---------------------------------------------------------------------------
//
// The non-interactive "fix it and finish" shorthand (D4). It acts ONLY on a
// `failed` run: re-run the failed step and drive the workflow forward to
// completion — the `[c]` retry-and-continue action without a keypress. On any
// other status it rejects with a status-named message and a non-zero exit
// (KTD-2); it never silently falls back to resume/read-only.
//
// There is no TTY/headless branch here, by design: the whole verb is "act, then
// finish", and the act path is the SAME host-free `runResumeExecution` core the
// `[c]` continue uses (KTD-5, the seam U6 pinned). That core builds whatever
// host the factory resolves — a two-pane host on a TTY (the user watches the
// retry execute, AT-R6), a plain host headless (runs to completion without a
// TUI, never blocks, AT-R8). Crucially it constructs NO interactive failure
// view, NO host→CLI action channel, and NO `ConfirmService` — so a headless
// `orch retry` can never hang on input or refuse by copying `resume`'s no-TTY
// path. The exit code reflects the retry outcome (completed → 0; failed-again →
// non-zero).

import { defaultInstructionResolver, type WorkflowArgs } from '../../core/index.ts'
import type { RunId, RunState } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import type { LoadedWorkflow } from './load-workflow.ts'
import { resolveExplicitTarget } from './resume.ts'
import { runResumeExecution } from './resume-execution.ts'

/**
 * `orch retry <id>`: resolve the id (prefix/not-found shared with `resume`),
 * then drive the auto retry-and-continue. A `failed` run runs to completion; any
 * other status is rejected. Bare `orch retry` (no id) is a usage error — retry
 * targets a specific run, unlike bare `resume`'s auto-discovery.
 */
export async function retryCmd(
  deps: CliDeps,
  idArg: string,
  cliArgs: WorkflowArgs,
  opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  if (!idArg) {
    process.stderr.write('retry requires a run id: orch retry <id>\n')
    return EXIT.CONFIG_ERROR
  }

  const resolved = await resolveExplicitTarget(deps, idArg)
  if (typeof resolved === 'number') return resolved
  const { targetId, state, workflowName } = resolved

  return retryRun({ deps, targetId, state, workflowName, cliArgs, opts, hostFactory })
}

export interface RetryRunArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly state: RunState
  readonly workflowName: string
  readonly cliArgs: WorkflowArgs
  readonly opts: CliOpts
  readonly hostFactory: HostFactory
  /**
   * Pre-loaded workflow. When omitted, the workflow is loaded from disk via
   * `loadWorkflow` (the normal CLI path). Tests inject a `FakeRunner`-backed
   * executor here to drive the real retry-and-continue without a
   * `.orch/workflows/` file.
   */
  readonly loaded?: LoadedWorkflow
}

/**
 * Status-gate + auto retry-and-continue. Reject every non-`failed` status with a
 * status-named, non-zero exit (KTD-2 / D4 / AT-R7); otherwise re-run the failed
 * step and continue to completion via the shared `runResumeExecution` core with
 * the U4 default instruction resolver (D7). Split out from `retryCmd` so tests
 * can drive the act path with an injected executor.
 */
export async function retryRun(args: RetryRunArgs): Promise<number> {
  const { deps, targetId, state, workflowName, cliArgs, opts, hostFactory, loaded } = args

  if (state.status !== 'failed') {
    process.stderr.write(
      `Cannot retry run ${targetId}: it is ${state.status}. ` +
        `Retry applies only to failed runs; use \`orch resume ${targetId}\`.\n`,
    )
    return EXIT.CANNOT_RESUME
  }

  process.stderr.write(`Retrying run ${targetId} (failed) and continuing...\n`)
  return runResumeExecution({
    deps,
    targetId,
    state,
    workflowName,
    cliArgs,
    opts,
    hostFactory,
    instructionResolver: defaultInstructionResolver,
    ...(loaded !== undefined ? { loaded } : {}),
  })
}
