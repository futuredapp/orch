import type { WorkflowArgs } from '../../core/index.ts'
import type { RunId } from '../../state/index.ts'
import { StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { glyphs } from '../format.ts'
import { type CliOpts, EXIT } from '../main.ts'

const GLYPH = glyphs(process.stdout.isTTY ?? false)

export async function statusCmd(
  deps: CliDeps,
  idArg: string,
  _args: WorkflowArgs = {},
  _opts: CliOpts = { mode: undefined, format: 'text', noAttach: false },
): Promise<number> {
  if (!idArg) {
    process.stderr.write('Usage: orch status <id>\n')
    return EXIT.CONFIG_ERROR
  }

  // Resolve prefix
  const matches = await deps.registry.findByPrefix(idArg)
  if (matches.length === 0) {
    process.stderr.write(`No run found matching "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }
  if (matches.length > 1) {
    process.stderr.write(
      `Ambiguous run ID prefix "${idArg}" matches ${matches.length} runs: ${matches.join(', ')}\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  const rid = matches[0] as RunId

  let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
  try {
    state = await deps.stateStore.loadRun(rid)
  } catch (err) {
    if (err instanceof StateCorruptionError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.CONFIG_ERROR
    }
    throw err
  }

  if (!state) {
    process.stderr.write(`Run "${rid}" not found\n`)
    return EXIT.CONFIG_ERROR
  }

  const glyph = GLYPH[state.status]
  process.stdout.write(`Run:      ${state.id}\n`)
  process.stdout.write(`Status:   ${glyph} ${state.status}\n`)
  if (state.workflowName) {
    process.stdout.write(`Workflow: ${state.workflowName}\n`)
  }

  const stepEntries = Object.values(state.steps)
  if (stepEntries.length === 0) {
    process.stdout.write('Steps:    (none)\n')
    return EXIT.OK
  }

  process.stdout.write(`Steps:    ${stepEntries.length}\n\n`)
  for (const s of stepEntries) {
    const dur = s.endedAt - s.startedAt
    process.stdout.write(`  ${GLYPH.completed} ${s.name.padEnd(30)} ${dur}ms\n`)
  }

  return EXIT.OK
}
