import {
  ParallelError,
  ResumeError,
  RunNotFoundError,
  SchemaValidationError,
  StepError,
  ViewResolutionError,
  type WorkflowArgs,
} from '../../core/index.ts'
import type { WorkflowDeps } from '../../core/workflow.ts'
import { HostCreationError } from '../../hosts/index.ts'
import { buildRunMeta, orchVersion, type SessionLogger } from '../../observability/index.ts'
import type { RunId } from '../../state/index.ts'
import { createTranscriptSidecar, StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

const SCAN_CAP = 50

async function findResumableRun(deps: CliDeps): Promise<RunId | undefined> {
  const runs = await deps.registry.listRuns()
  const recent = runs.slice(-SCAN_CAP).reverse()

  for (const rid of recent) {
    const state = await deps.stateStore.loadRun(rid)
    if (state && (state.status === 'crashed' || state.status === 'running')) {
      return rid
    }
  }
  return undefined
}

async function findByPrefix(deps: CliDeps, prefix: string): Promise<RunId | undefined> {
  const matches = await deps.registry.findByPrefix(prefix)
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    process.stderr.write(
      `Ambiguous run ID prefix "${prefix}" matches ${matches.length} runs: ${matches.join(', ')}\n`,
    )
    return undefined
  }
  return matches[0]
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

function mapResumeError(err: unknown): number | undefined {
  if (err instanceof RunNotFoundError || err instanceof ResumeError) {
    process.stderr.write(`${err.message}\n`)
    return EXIT.CANNOT_RESUME
  }
  if (err instanceof ViewResolutionError || err instanceof StateCorruptionError) {
    process.stderr.write(`${err.message}\n`)
    return EXIT.CONFIG_ERROR
  }
  if (
    err instanceof StepError ||
    err instanceof SchemaValidationError ||
    err instanceof ParallelError
  ) {
    process.stderr.write(`${err.message}\n`)
    return EXIT.STEP_FAILURE
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

interface ResolvedResumeTarget {
  readonly targetId: RunId
  readonly state: NonNullable<Awaited<ReturnType<CliDeps['stateStore']['loadRun']>>>
  readonly workflowName: string
}

async function resolveResumeTarget(
  deps: CliDeps,
  idArg: string,
): Promise<ResolvedResumeTarget | number> {
  const targetId = idArg ? await findByPrefix(deps, idArg) : await findResumableRun(deps)
  if (targetId === undefined) {
    process.stderr.write(
      idArg
        ? `No run found matching "${idArg}"\n`
        : 'No resumable run found (no crashed or running runs)\n',
    )
    return EXIT.CANNOT_RESUME
  }

  let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
  try {
    state = await deps.stateStore.loadRun(targetId)
  } catch (err) {
    if (err instanceof StateCorruptionError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.CONFIG_ERROR
    }
    throw err
  }
  if (!state) {
    process.stderr.write(`Run "${targetId}" not found\n`)
    return EXIT.CANNOT_RESUME
  }
  if (!state.workflowName) {
    process.stderr.write(
      `Run "${targetId}" has no workflowName (v2 state). ` +
        'Provide the workflow name: orch run <name>\n',
    )
    return EXIT.CANNOT_RESUME
  }
  return { targetId, state, workflowName: state.workflowName }
}

export async function resumeCmd(
  deps: CliDeps,
  idArg: string,
  cliArgs: WorkflowArgs,
  opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  const resolved = await resolveResumeTarget(deps, idArg)
  if (typeof resolved === 'number') return resolved
  const { targetId, state, workflowName } = resolved

  process.stderr.write(`Resuming run ${targetId}...\n`)

  const effectiveArgs = await resolveEffectiveArgs(deps, targetId, state.args, cliArgs)

  const loaded = await loadWorkflow(deps.cwd, workflowName)
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

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId: targetId,
        workflowName,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
      })
    } catch (err) {
      if (err instanceof HostCreationError) {
        process.stderr.write(`${err.message}\n`)
        return EXIT.CONFIG_ERROR
      }
      throw err
    }

    const transcriptSidecar = createTranscriptSidecar({
      fs: deps.fsService,
      runId: targetId,
      basePath: deps.statePath,
    })

    const wfDeps: WorkflowDeps = {
      stateStore: deps.stateStore,
      processService: deps.processService,
      clock: deps.clock,
      runId: targetId,
      cwd: deps.cwd,
      fsService: deps.fsService,
      gitService: deps.gitService,
      workflowName,
      args: effectiveArgs,
      host,
      transcriptSidecar,
      logger,
    }

    return await executeWithAttach({
      host,
      workflow: loaded.executor.resume(wfDeps),
      runId: targetId,
      stderr: process.stderr,
      mapError: mapResumeError,
      onSuccess: () => process.stderr.write(`Run ${targetId} completed.\n`),
    })
  } finally {
    await logger.close()
  }
}
