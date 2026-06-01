import type { WorkflowArgs } from '../../core/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { isLoadError, loadWorkflow } from './load-workflow.ts'

// DryRunAbort sentinel and first-step-peek are deferred to a follow-up PR.
// The symbol-tagged class (not extending Error) is the planned approach.

const PROMPT_PREVIEW_MAX = 80

function formatPromptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PROMPT_PREVIEW_MAX) return normalized
  return `${normalized.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
}

export async function dryRunCmd(
  deps: CliDeps,
  name: string,
  args: WorkflowArgs,
  _opts: CliOpts = {
    mode: undefined,
    format: 'text',
    noAttach: false,
    debug: false,
    interactivity: 'interactive',
    latest: false,
    step: undefined,
    follow: false,
    watch: false,
  },
): Promise<number> {
  if (!name) {
    process.stderr.write('Usage: orch dry-run <name> [prompt]\n')
    return EXIT.CONFIG_ERROR
  }

  const loaded = await loadWorkflow(deps.cwd, name)
  if (isLoadError(loaded)) return loaded.code

  process.stdout.write(`Dry-run: "${name}"\n\n`)
  process.stdout.write(`Workflow "${loaded.executor.name}" loaded successfully.\n`)
  if (args.prompt !== undefined) {
    process.stdout.write(`Prompt:   ${formatPromptPreview(args.prompt)}\n`)
  }

  return EXIT.OK
}
