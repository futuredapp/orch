import {
  ParallelError,
  ResumeError,
  RunNotFoundError,
  SchemaValidationError,
  StepError,
  type WorkflowArgs,
} from '../../core/index.ts'
import type { WorkflowDeps } from '../../core/workflow.ts'
import type { RunId } from '../../state/index.ts'
import { StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { maybeSetupTmux, type TmuxHandles, tmuxDepsFromHandles } from '../tmux-wiring.ts'
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
  if (err instanceof StateCorruptionError) {
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
  opts: CliOpts = { tmux: false, observe: false },
): Promise<number> {
  const targetId = idArg ? await findByPrefix(deps, idArg) : await findResumableRun(deps)

  if (targetId === undefined) {
    const msg = idArg
      ? `No run found matching "${idArg}"\n`
      : 'No resumable run found (no crashed or running runs)\n'
    process.stderr.write(msg)
    return EXIT.CANNOT_RESUME
  }

  const state = await deps.stateStore.loadRun(targetId)
  if (!state) {
    process.stderr.write(`Run "${targetId}" not found\n`)
    return EXIT.CANNOT_RESUME
  }

  process.stdout.write(`Resuming run ${targetId}...\n`)

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

  const tmuxResult = await maybeSetupTmux({
    enabled: opts.tmux,
    processService: deps.processService,
    clock: deps.clock,
    runId: targetId,
    workflowName,
    observe: opts.observe,
    stderr: process.stderr,
  })
  if (tmuxResult === 'argv-error') return EXIT.CONFIG_ERROR
  const tmuxHandles: TmuxHandles | undefined = tmuxResult

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
    ...(tmuxHandles !== undefined ? tmuxDepsFromHandles(tmuxHandles) : {}),
  }

  try {
    await loaded.executor.resume(wfDeps)
  } catch (err) {
    const code = mapResumeError(err)
    if (code !== undefined) return code
    throw err
  } finally {
    if (tmuxHandles !== undefined) {
      await tmuxHandles.teardown()
    }
  }

  process.stdout.write(`Run ${targetId} completed.\n`)
  return EXIT.OK
}
