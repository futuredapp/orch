import type { WorkflowArgs } from '../../core/index.ts'
import { path } from '../../services/types.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { isInsideOrchSourceRepo } from './detect-self.ts'
import { newWorkflowTemplate } from './init-templates.ts'
import { appendWorkflowToManifest } from './scaffold.ts'

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export async function newCmd(
  deps: CliDeps,
  positional: string,
  _args: WorkflowArgs,
  _opts: CliOpts,
): Promise<number> {
  if (positional === '') {
    process.stderr.write('Usage: orch new <name>\n')
    return EXIT.CONFIG_ERROR
  }

  if (await isInsideOrchSourceRepo({ fsService: deps.fsService }, deps.cwd)) {
    process.stderr.write(
      `Refusing to run \`orch new\` inside the orch source repository. ` +
        `Switch to a host project and try again.\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  if (!NAME_PATTERN.test(positional)) {
    process.stderr.write(
      `Invalid workflow name "${positional}". ` +
        `Must be lowercase kebab-case (starts with a letter; ASCII letters, digits, hyphens).\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  const orchDir = path(`${deps.cwd}/.orch`)
  if (!(await deps.fsService.exists(orchDir))) {
    process.stderr.write('No .orch/ found. Run `orch init` first.\n')
    return EXIT.CONFIG_ERROR
  }

  const workflowPath = path(`${orchDir}/workflows/${positional}.ts`)
  if (await deps.fsService.exists(workflowPath)) {
    process.stderr.write(`Refusing to overwrite existing workflow at ${workflowPath}.\n`)
    return EXIT.CONFIG_ERROR
  }

  await deps.fsService.writeFile(workflowPath, newWorkflowTemplate(positional))

  try {
    await appendWorkflowToManifest(
      deps.fsService,
      path(`${orchDir}/orch.config.ts`),
      positional,
      `workflows/${positional}.ts`,
    )
  } catch (err) {
    process.stderr.write(
      `Created ${workflowPath}, but could not update the manifest: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  process.stdout.write(
    `Created .orch/workflows/${positional}.ts — run it with: orch run ${positional}\n`,
  )
  return EXIT.OK
}
