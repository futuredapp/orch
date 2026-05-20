import type { WorkflowArgs } from '../../core/index.ts'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { isInsideOrchSourceRepo } from './detect-self.ts'
import {
  appendWorkflowToManifest,
  ensureGitignoreLine,
  preservingReinitFiles,
  removeOrchTree,
  writeOrchTree,
} from './scaffold.ts'

const HINT =
  `Created .orch/ with a hello-world workflow.\n` +
  `Run it with:           orch run hello\n` +
  `Add more workflows:    orch new <name>\n`

export async function initCmd(
  deps: CliDeps,
  _positional: string,
  _args: WorkflowArgs,
  opts: CliOpts,
): Promise<number> {
  if (await isInsideOrchSourceRepo({ fsService: deps.fsService }, deps.cwd)) {
    process.stderr.write(
      `Refusing to run \`orch init\` inside the orch source repository. ` +
        `Switch to a host project (e.g. one where you ran \`bun link orch\`) and try again.\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  const orchDir = path(`${deps.cwd}/.orch`)
  if (await deps.fsService.exists(orchDir)) {
    return reinitFlow(deps, opts, orchDir)
  }

  await writeOrchTree(deps.fsService, orchDir)
  await ensureGitignoreLine(deps.fsService, path(`${deps.cwd}/.gitignore`), '.orch/state/')
  process.stdout.write(HINT)
  return EXIT.OK
}

/**
 * F2 — re-init flow. Refuses to prompt under non-interactive conditions
 * (R9), then asks two confirms (R7 replace, R8 keep workflows). Keep mode
 * preserves `.orch/state/` and every `workflows/*.ts` except `hello.ts`;
 * don't-keep mode wipes `.orch/` and re-runs the F1 path. Filled out in U6.
 */
async function reinitFlow(deps: CliDeps, opts: CliOpts, orchDir: Path): Promise<number> {
  if (opts.interactivity === 'noninteractive' || deps.isStdinTty === false) {
    process.stderr.write(
      `\`.orch/\` already exists at ${orchDir}.\n` +
        `Re-running \`orch init\` overwrites scaffolded files; this requires an interactive terminal.\n` +
        `Either run interactively (no --noninteractive, attached stdin) or remove .orch/ manually.\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  const replace = await deps.confirmService.confirm('`.orch/` already exists. Replace it?', false)
  if (!replace) {
    process.stdout.write('No changes made.\n')
    return EXIT.OK
  }

  const keep = await deps.confirmService.confirm('Keep your existing user workflows?', true)
  if (keep) {
    const { preservedWorkflows } = await preservingReinitFiles(deps.fsService, orchDir)
    await writeOrchTree(deps.fsService, orchDir)
    for (const wfPath of preservedWorkflows) {
      const name = wfPath.split('/').pop()?.replace(/\.ts$/, '')
      if (!name) continue
      await appendWorkflowToManifest(
        deps.fsService,
        path(`${orchDir}/orch.config.ts`),
        name,
        `workflows/${name}.ts`,
      )
    }
  } else {
    await removeOrchTree(deps.fsService, orchDir)
    await writeOrchTree(deps.fsService, orchDir)
  }

  await ensureGitignoreLine(deps.fsService, path(`${deps.cwd}/.gitignore`), '.orch/state/')
  process.stdout.write(HINT)
  return EXIT.OK
}
