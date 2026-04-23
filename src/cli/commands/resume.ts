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

export async function resumeCmd(
  deps: CliDeps,
  idArg: string,
  cliArgs: WorkflowArgs,
  _opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  const targetId = idArg ? await findByPrefix(deps, idArg) : await findResumableRun(deps)

  if (targetId === undefined) {
    const msg = idArg
      ? `No run found matching "${idArg}"\n`
      : 'No resumable run found (no crashed or running runs)\n'
    process.stderr.write(msg)
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

  process.stderr.write(`Resuming run ${targetId}...\n`)

  const workflowName = state.workflowName
  if (!workflowName) {
    process.stderr.write(
      `Run "${targetId}" has no workflowName (v2 state). ` +
        'Provide the workflow name: orch run <name>\n',
    )
    return EXIT.CANNOT_RESUME
  }

  const effectiveArgs = await resolveEffectiveArgs(deps, targetId, state.args, cliArgs)

  const loaded = await loadWorkflow(deps.cwd, workflowName)
  if (isLoadError(loaded)) return loaded.code

  let host: Awaited<ReturnType<HostFactory>>
  try {
    host = await hostFactory({
      runId: targetId,
      workflowName,
      stdout: process.stdout,
      stderr: process.stderr,
      clock: deps.clock,
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
  }

  return await executeWithAttach({
    host,
    workflow: loaded.executor.resume(wfDeps),
    runId: targetId,
    stderr: process.stderr,
    mapError: mapResumeError,
    onSuccess: () => process.stderr.write(`Run ${targetId} completed.\n`),
  })
}
