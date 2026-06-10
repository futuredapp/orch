// ---------------------------------------------------------------------------
// resume-execution — the shared "re-run a run to completion" execution block.
// ---------------------------------------------------------------------------
//
// Lifted verbatim out of `resumeCmd` so two callers share one proven path:
//
//   - `resumeCmd` for a `crashed`/`running` run (the unchanged real resume).
//   - `openFailed`'s `[c]` retry-and-continue action (plan U6) — re-run the
//     failed step and drive the workflow forward to completion. This is the
//     same `executor.resume()` re-run, now triggered by a user action, with the
//     U4 instruction resolver injected so the agent receives the
//     configured/default retry instruction (D7 / KTD-5).
//
// `runResumeExecution` constructs the executing host + cmux + logger preamble
// and races the workflow against foreground shutdown via `executeWithAttach`.
// Because it reuses the real resume host construction, a successful continue
// naturally fires `run:ended` and flips the cmux pill `failed → completed`
// (AT-R11) — the legitimate, intentional mutation of an *actioned* failed run.

import {
  createResumeRegistry,
  type InstructionResolver,
  ParallelError,
  ResumeError,
  RunNotFoundError,
  SchemaValidationError,
  StepError,
  ViewResolutionError,
  type WorkflowArgs,
  type WorkflowDeps,
} from '../../core/index.ts'
import {
  createCmuxHost,
  createCompositeHost,
  HostCreationError,
  HostUnavailableError,
} from '../../hosts/index.ts'
import {
  buildRunMeta,
  instrumentProcessService,
  orchVersion,
  type SessionLogger,
} from '../../observability/index.ts'
import type { RunId, RunState } from '../../state/index.ts'
import { createTranscriptSidecar, StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import { isLoadError, type LoadedWorkflow, loadWorkflow } from './load-workflow.ts'
import { relativeRunDir } from './relative-run-dir.ts'

export function mapResumeError(err: unknown): { code: number; reason: string } | undefined {
  if (err instanceof RunNotFoundError || err instanceof ResumeError) {
    return { code: EXIT.CANNOT_RESUME, reason: err.message }
  }
  if (err instanceof ViewResolutionError || err instanceof StateCorruptionError) {
    return { code: EXIT.CONFIG_ERROR, reason: err.message }
  }
  if (
    err instanceof StepError ||
    err instanceof SchemaValidationError ||
    err instanceof ParallelError
  ) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  if (err instanceof HostUnavailableError) {
    return { code: EXIT.STEP_FAILURE, reason: err.message }
  }
  return undefined
}

async function writeResumePreamble(
  logger: SessionLogger,
  ctx: {
    readonly runId: string
    readonly workflowName: string
    readonly mode: string
    readonly debug: boolean
    readonly argv: readonly string[]
    readonly env: Readonly<Record<string, string | undefined>>
    readonly startedAtIso: string
    readonly resumedAtIso: string
    readonly emitEnvValues: boolean
  },
): Promise<void> {
  const version = await orchVersion()
  const meta = buildRunMeta({
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    argv: ctx.argv,
    env: ctx.env,
    mode: ctx.mode,
    debug: ctx.debug,
    orchVersion: version,
    os: process.platform,
    startedAtIso: ctx.startedAtIso,
    resumedAtIso: ctx.resumedAtIso,
    emitEnvValues: ctx.emitEnvValues,
  })
  await logger.writeFile('run.meta.json', `${JSON.stringify(meta, null, 2)}\n`)
  await logger.append('lifecycle', {
    type: 'run:resumed',
    resumedAt: ctx.resumedAtIso,
  })
}

async function resolveEffectiveArgs(
  deps: CliDeps,
  targetId: RunId,
  persisted: WorkflowArgs | undefined,
  cliArgs: WorkflowArgs,
): Promise<WorkflowArgs> {
  if (cliArgs.prompt === undefined) return persisted ?? {}
  await deps.stateStore.setArgs(targetId, cliArgs)
  return cliArgs
}

export interface RunResumeExecutionArgs {
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
   * executor here to drive the real execution without a `.orch/workflows/` file.
   */
  readonly loaded?: LoadedWorkflow
  /**
   * U4/D7: the retry/continue instruction resolver injected on the manual path
   * (`[c]` / `orch retry`). Absent → the executor's `defaultInstructionResolver`
   * applies (the built-in `'continue'`), preserving the autonomous-loop
   * behavior for an ordinary `crashed`/`running` resume.
   */
  readonly instructionResolver?: InstructionResolver
}

/**
 * Re-run `targetId` to completion: build the executing host + cmux, write the
 * resume preamble, and race `executor.resume()` against foreground shutdown.
 * Shared by `resumeCmd` (crashed/running) and `openFailed`'s `[c]` action.
 */
export async function runResumeExecution(args: RunResumeExecutionArgs): Promise<number> {
  const { deps, targetId, state, workflowName, cliArgs, opts, hostFactory } = args

  const effectiveArgs = await resolveEffectiveArgs(deps, targetId, state.args, cliArgs)

  const loaded = args.loaded ?? (await loadWorkflow(deps.cwd, workflowName))
  if (isLoadError(loaded)) return loaded.code

  const logger = deps.sessionLoggerFor(targetId)
  const resumedAtIso = new Date(deps.clock.now()).toISOString()
  const startedAtIso = new Date(state.startedAt ?? deps.clock.now()).toISOString()

  try {
    await writeResumePreamble(logger, {
      runId: targetId,
      workflowName,
      mode: opts.mode ?? 'plain',
      debug: deps.debug,
      argv: process.argv,
      env: process.env,
      startedAtIso,
      resumedAtIso,
      emitEnvValues: process.env.ORCH_LOG_ENV_VALUES === '1',
    })

    const instrumentedProcess = instrumentProcessService(deps.processService, {
      logger,
      clock: deps.clock,
    })

    // On resume, the workflow callback re-invokes `run(step)` for every step;
    // `runStepOnce` re-registers each interactive runner in the registry,
    // including cache hits. The host therefore sees the runner the moment
    // the executor reaches that step.
    const resumeRegistry = createResumeRegistry()

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId: targetId,
        workflowName,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
        processService: instrumentedProcess,
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

    const cmuxHost = await createCmuxHost({
      processService: instrumentedProcess,
      clock: deps.clock,
      workflowName,
      cmuxConfig: loaded.config.cmux,
      env: process.env,
      cwd: deps.cwd,
      logger,
    })
    const compositeHost = createCompositeHost(host, cmuxHost)

    const transcriptSidecar = createTranscriptSidecar({
      fs: deps.fsService,
      runId: targetId,
      basePath: deps.statePath,
    })

    const wfDeps: WorkflowDeps = {
      stateStore: deps.stateStore,
      processService: instrumentedProcess,
      clock: deps.clock,
      runId: targetId,
      cwd: deps.cwd,
      fsService: deps.fsService,
      gitService: deps.gitService,
      workflowName,
      args: effectiveArgs,
      host: compositeHost,
      transcriptSidecar,
      logger,
      promptService: deps.promptServiceFor(host.mode),
      interactivity: opts.interactivity,
      resumeRegistry,
      ...(args.instructionResolver !== undefined
        ? { instructionResolver: args.instructionResolver }
        : {}),
    }

    return await executeWithAttach({
      host: compositeHost,
      workflow: loaded.executor.resume(wfDeps),
      runId: targetId,
      stderr: process.stderr,
      mapError: mapResumeError,
      summary: {
        workflowName,
        runDir: relativeRunDir(deps.cwd, deps.statePath, targetId),
      },
      logger,
      skipAttach: opts.noAttach,
      beforeTeardown: (exitCode) => cmuxHost.notifyRunEnd(exitCode),
    })
  } finally {
    await logger.close()
  }
}
