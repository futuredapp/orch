import {
  ParallelError,
  SchemaValidationError,
  StepError,
  ViewResolutionError,
} from '../../core/index.ts'
import type { WorkflowArgs, WorkflowDeps } from '../../core/workflow.ts'
import { HostCreationError } from '../../hosts/index.ts'
import { createTranscriptSidecar, generateRunId } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

const PROMPT_PREVIEW_MAX = 80

function formatPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PROMPT_PREVIEW_MAX) return normalized
  return `${normalized.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
}

function mapRunError(err: unknown): number | undefined {
  if (err instanceof ViewResolutionError) {
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

export async function runCmd(
  deps: CliDeps,
  name: string,
  args: WorkflowArgs,
  _opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  if (!name) {
    process.stderr.write('Usage: orch run <name> [prompt]\n')
    return EXIT.CONFIG_ERROR
  }

  const result = await loadWorkflow(deps.cwd, name)
  if (isLoadError(result)) return result.code

  const runId = generateRunId({ clock: deps.clock })
  const promptSuffix =
    args.prompt !== undefined ? ` with prompt: "${formatPromptPreview(args.prompt)}"` : ''
  process.stderr.write(`Running workflow "${name}" (${runId})${promptSuffix}...\n`)

  let host: Awaited<ReturnType<HostFactory>>
  try {
    host = await hostFactory({
      runId,
      workflowName: name,
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
    runId,
    basePath: deps.statePath,
  })

  const wfDeps: WorkflowDeps = {
    stateStore: deps.stateStore,
    processService: deps.processService,
    clock: deps.clock,
    runId,
    cwd: deps.cwd,
    fsService: deps.fsService,
    gitService: deps.gitService,
    workflowName: name,
    args,
    host,
    transcriptSidecar,
  }

  return await executeWithAttach({
    host,
    workflow: result.executor.execute(wfDeps),
    runId,
    stderr: process.stderr,
    mapError: mapRunError,
    onSuccess: () => process.stderr.write(`Workflow "${name}" completed.\n`),
  })
}
