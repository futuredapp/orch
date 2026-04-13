import { ParallelError, SchemaValidationError, StepError } from '../../core/index.ts'
import type { WorkflowDeps } from '../../core/workflow.ts'
import { generateRunId } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { EXIT } from '../main.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

export async function runCmd(deps: CliDeps, name: string): Promise<number> {
  if (!name) {
    process.stderr.write('Usage: orch run <name>\n')
    return EXIT.CONFIG_ERROR
  }

  const result = await loadWorkflow(deps.cwd, name)
  if (isLoadError(result)) return result.code

  const runId = generateRunId({ clock: deps.clock })
  process.stdout.write(`Running workflow "${name}" (${runId})...\n`)

  const wfDeps: WorkflowDeps = {
    stateStore: deps.stateStore,
    processService: deps.processService,
    clock: deps.clock,
    runId,
    cwd: deps.cwd,
    fsService: deps.fsService,
    gitService: deps.gitService,
    workflowName: name,
  }

  try {
    await result.executor.execute(wfDeps)
  } catch (err) {
    if (
      err instanceof StepError ||
      err instanceof SchemaValidationError ||
      err instanceof ParallelError
    ) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.STEP_FAILURE
    }
    throw err
  }

  process.stdout.write(`Workflow "${name}" completed.\n`)
  return EXIT.OK
}
