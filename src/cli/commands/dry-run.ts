import type { CliDeps } from '../deps.ts'
import { EXIT } from '../main.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

// DryRunAbort sentinel and first-step-peek are deferred to a follow-up PR.
// The symbol-tagged class (not extending Error) is the planned approach.

export async function dryRunCmd(deps: CliDeps, name: string): Promise<number> {
  if (!name) {
    process.stderr.write('Usage: orch dry-run <name>\n')
    return EXIT.CONFIG_ERROR
  }

  const loaded = await loadWorkflow(deps.cwd, name)
  if (isLoadError(loaded)) return loaded.code

  process.stdout.write(`Dry-run: "${name}"\n\n`)
  process.stdout.write(`Workflow "${loaded.executor.name}" loaded successfully.\n`)

  return EXIT.OK
}
