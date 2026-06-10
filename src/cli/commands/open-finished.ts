// ---------------------------------------------------------------------------
// openFinished — re-open a finished run in the read-only end-of-run TUI.
// ---------------------------------------------------------------------------
//
// The mechanical core of the "pure open" guarantee (brainstorm D6 / KTD-1):
// this path NEVER calls `executor.resume()` (which would `setStatus('running')`
// and re-execute — `workflow.ts:resume`), NEVER writes a resume preamble
// (`run:resumed` lifecycle + `run.meta.json`), and installs NO cmux host (so
// the teardown `notifyRunEnd` hook can never clear/flip a status pill). The
// two-pane host's steps-view daemon tails the already-finished `state.json` and
// projects the terminal `completed`/`failed` view via `finalizeView` — no
// execution required. A clean `q` exits `0`.

import { createResumeRegistry, type ResumeRegistry } from '../../core/index.ts'
import { HostCreationError } from '../../hosts/index.ts'
import type { RunId, RunState } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import type { LoadedWorkflow } from './load-workflow.ts'
import { rehydrateResumeRegistry } from './rehydrate-registry.ts'
import { relativeRunDir } from './relative-run-dir.ts'

export interface OpenFinishedArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly workflowName: string
  readonly status: RunState['status']
  readonly opts: CliOpts
  readonly hostFactory: HostFactory
  /**
   * Pre-loaded workflow forwarded to the registry rehydration. The CLI leaves
   * this absent (rehydration loads from `.orch/`); tests inject a
   * `FakeRunner`-backed executor so a fixture-seeded run rehydrates without a
   * real workflow file.
   */
  readonly loaded?: LoadedWorkflow
  /**
   * Live runner registry. The CLI leaves this absent (one is created here and
   * threaded into both rehydration and the host); tests inject one to assert
   * the cold open rehydrated it.
   */
  readonly resumeRegistry?: ResumeRegistry
}

/**
 * Launch the read-only end-of-run viewer for a finished run. Builds the
 * two-pane host (which mounts the steps-view daemon tailing the persisted
 * `state.json`) and waits for the user to dismiss it — no executor, no cmux,
 * no preamble, no run-log writes.
 */
export async function openFinished(args: OpenFinishedArgs): Promise<number> {
  const { deps, targetId, workflowName, status, opts, hostFactory } = args

  process.stderr.write(`Opening run ${targetId} (${status}) in read-only view...\n`)

  // A logger is required by the host factory, but the pure open never appends
  // to it: no preamble, no run-end notify. Closing a never-written logger is a
  // no-op flush, so `logs/` stays byte-for-byte unchanged (AT-17).
  const logger = deps.sessionLoggerFor(targetId)
  try {
    const resumeRegistry = args.resumeRegistry ?? createResumeRegistry()

    // Refill the registry from the persisted run so the right pane can resolve
    // a past interactive step's runner on `⏎` (and relaunch `<runner> --resume
    // <sessionId>`) — the cold open has no executor to populate it live. Pure:
    // a no-mutation replay against a NullHost with no logger (AT-5/AT-17).
    await rehydrateResumeRegistry({
      deps,
      targetId,
      workflowName,
      resumeRegistry,
      opts,
      ...(args.loaded !== undefined ? { loaded: args.loaded } : {}),
    })

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId: targetId,
        workflowName,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
        // The raw (un-instrumented) process service: the read-only open spawns
        // only tmux, and instrumentation would otherwise be a needless log vector.
        processService: deps.processService,
        fs: deps.fsService,
        stateStore: deps.stateStore,
        resumeRegistry,
      })
    } catch (err) {
      if (err instanceof HostCreationError) {
        process.stderr.write(`${err.message}\n`)
        return EXIT.CONFIG_ERROR
      }
      throw err
    }

    // No cmux host and no `beforeTeardown` hook: a pure open emits no
    // run-lifecycle events and touches no status pill (AT-15/AT-16).
    return await executeWithAttach({
      host,
      workflow: Promise.resolve(),
      runId: targetId,
      stderr: process.stderr,
      mapError: () => undefined,
      summary: {
        workflowName,
        runDir: relativeRunDir(deps.cwd, deps.statePath, targetId),
      },
      logger,
      skipAttach: opts.noAttach,
      readOnly: true,
    })
  } finally {
    await logger.close()
  }
}
