import {
  ConfigLoadError,
  loadConfig,
  type OrchestratorConfig,
  resolveWorkflow,
} from '../../config/index.ts'
import type { WorkflowExecutor } from '../../core/workflow.ts'
import type { Path } from '../../services/types.ts'
import { EXIT } from '../main.ts'

interface LoadResult {
  readonly executor: WorkflowExecutor
  readonly config: OrchestratorConfig
}

interface LoadError {
  readonly code: number
}

function isExecutorShape(v: unknown): v is WorkflowExecutor {
  return typeof v === 'object' && v !== null && 'execute' in v && 'resume' in v
}

function extractDefault(mod: unknown): unknown {
  return typeof mod === 'object' && mod !== null && 'default' in mod
    ? (mod as { default: unknown }).default
    : undefined
}

export async function loadWorkflow(cwd: Path, name: string): Promise<LoadResult | LoadError> {
  let config: OrchestratorConfig
  try {
    config = await loadConfig(cwd)
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      process.stderr.write(`${err.message}\n`)
      return { code: EXIT.CONFIG_ERROR }
    }
    throw err
  }

  let workflowPath: Path
  try {
    workflowPath = resolveWorkflow(config, name, cwd)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return { code: EXIT.CONFIG_ERROR }
  }

  let mod: unknown
  try {
    mod = await import(workflowPath)
  } catch (err) {
    process.stderr.write(
      `Cannot load workflow at ${workflowPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return { code: EXIT.CONFIG_ERROR }
  }

  const defaultExport = extractDefault(mod)
  if (!isExecutorShape(defaultExport)) {
    process.stderr.write(
      `Workflow at ${workflowPath} must export a default WorkflowExecutor (use workflow())\n`,
    )
    return { code: EXIT.CONFIG_ERROR }
  }

  return { executor: defaultExport, config }
}

export function isLoadError(r: LoadResult | LoadError): r is LoadError {
  return 'code' in r
}
