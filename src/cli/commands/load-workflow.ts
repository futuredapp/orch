import {
  ConfigLoadError,
  loadConfig,
  type OrchestratorConfig,
  resolveWorkflow,
} from '../../config/index.ts'
import { bodyHandle, type WorkflowExecutor } from '../../core/workflow.ts'
import type { Path } from '../../services/types.ts'
import { isBuiltinName, resolveBuiltin } from '../../workflows/index.ts'
import { EXIT } from '../main.ts'

export interface LoadResult {
  readonly executor: WorkflowExecutor
  readonly config: OrchestratorConfig
}

/** Alias for the successful load shape — used by callers that pre-load a
 *  workflow and pass it into the resume/retry execution seam (tests inject a
 *  `FakeRunner`-backed executor here). */
export type LoadedWorkflow = LoadResult

interface LoadError {
  readonly code: number
}

function isExecutorShape(v: unknown): v is WorkflowExecutor {
  return typeof v === 'object' && v !== null && 'execute' in v && 'resume' in v && bodyHandle in v
}

function extractDefault(mod: unknown): unknown {
  return typeof mod === 'object' && mod !== null && 'default' in mod
    ? (mod as { default: unknown }).default
    : undefined
}

export interface LoadWorkflowOptions {
  /**
   * Suppress the user-facing stderr error messages. Set by best-effort callers
   * (the cold-open registry rehydration) that silently degrade when the
   * workflow can't be loaded — a normal read-only open must not print an
   * alarming "Cannot load config" line.
   */
  readonly quiet?: boolean
}

export async function loadWorkflow(
  cwd: Path,
  name: string,
  opts: LoadWorkflowOptions = {},
): Promise<LoadResult | LoadError> {
  const reportError = (message: string): void => {
    if (!opts.quiet) process.stderr.write(message)
  }
  let config: OrchestratorConfig
  let configDir: Path
  try {
    const loaded = await loadConfig(cwd)
    config = loaded.config
    configDir = loaded.configDir
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      reportError(`${err.message}\n`)
      return { code: EXIT.CONFIG_ERROR }
    }
    throw err
  }

  // `orch::<name>` routes to a packaged built-in resolved against orch's own
  // source tree, bypassing the user's `config.workflows` map entirely. Config
  // is still loaded above (run state/mode resolution), so a built-in run with
  // no `.orch/` surfaces the same ConfigLoadError as a bare-name run. Bare
  // names resolve exactly as before.
  let workflowPath: Path
  try {
    workflowPath = isBuiltinName(name)
      ? resolveBuiltin(name)
      : resolveWorkflow(config, name, configDir)
  } catch (err) {
    reportError(`${err instanceof Error ? err.message : String(err)}\n`)
    return { code: EXIT.CONFIG_ERROR }
  }

  let mod: unknown
  try {
    mod = await import(workflowPath)
  } catch (err) {
    reportError(
      `Cannot load workflow at ${workflowPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return { code: EXIT.CONFIG_ERROR }
  }

  const defaultExport = extractDefault(mod)
  if (!isExecutorShape(defaultExport)) {
    reportError(
      `Workflow at ${workflowPath} must export a default WorkflowExecutor (use workflow())\n`,
    )
    return { code: EXIT.CONFIG_ERROR }
  }

  return { executor: defaultExport, config }
}

export function isLoadError(r: LoadResult | LoadError): r is LoadError {
  return 'code' in r
}
