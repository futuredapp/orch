import { ParallelError, SchemaValidationError, StepError } from '../../core/index.ts'
import type { WorkflowArgs, WorkflowDeps } from '../../core/workflow.ts'
import { generateRunId } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { maybeSetupTmux, type TmuxHandles, tmuxDepsFromHandles } from '../tmux-wiring.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

const PROMPT_PREVIEW_MAX = 80

function formatPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PROMPT_PREVIEW_MAX) return normalized
  return `${normalized.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
}

function mapRunError(err: unknown): number | undefined {
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
  opts: CliOpts = { tmux: false, observe: false },
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
  process.stdout.write(`Running workflow "${name}" (${runId})${promptSuffix}...\n`)

  const tmuxResult = await maybeSetupTmux({
    enabled: opts.tmux,
    processService: deps.processService,
    clock: deps.clock,
    runId,
    workflowName: name,
    observe: opts.observe,
    stderr: process.stderr,
  })
  if (tmuxResult === 'argv-error') return EXIT.CONFIG_ERROR
  const tmuxHandles: TmuxHandles | undefined = tmuxResult

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
    ...(tmuxHandles !== undefined ? tmuxDepsFromHandles(tmuxHandles) : {}),
  }

  try {
    await result.executor.execute(wfDeps)
  } catch (err) {
    const code = mapRunError(err)
    if (code !== undefined) return code
    throw err
  } finally {
    if (tmuxHandles !== undefined) {
      await tmuxHandles.teardown()
    }
  }

  process.stdout.write(`Workflow "${name}" completed.\n`)
  return EXIT.OK
}
