import type { WorkflowArgs } from '../../core/index.ts'
import type { CliDeps } from '../deps.ts'
import { formatDuration, glyphs } from '../format.ts'
import { type CliOpts, EXIT } from '../main.ts'

const DEFAULT_LIMIT = 20

const GLYPH = glyphs(process.stdout.isTTY ?? false)

export async function runsCmd(
  deps: CliDeps,
  _positional: string,
  _args: WorkflowArgs = {},
  _opts: CliOpts = {
    mode: undefined,
    format: 'text',
    noAttach: false,
    debug: false,
    interactivity: 'interactive',
  },
): Promise<number> {
  const allRuns = await deps.registry.listRuns()
  const recentIds = allRuns.slice(-DEFAULT_LIMIT)

  if (recentIds.length === 0) {
    process.stdout.write('No runs found.\n')
    return EXIT.OK
  }

  const rows: string[] = []
  for (const rid of recentIds) {
    const state = await deps.stateStore.loadRun(rid)
    if (!state) continue

    const glyph = GLYPH[state.status]
    const name = state.workflowName ?? '\u2014'
    const dur = formatDuration(state)
    const stepsCount = Object.keys(state.steps).length

    rows.push(
      `  ${glyph} ${rid.padEnd(26)} ${state.status.padEnd(10)} ${name.padEnd(20)} ${String(stepsCount).padEnd(6)} ${dur}`,
    )
  }

  process.stdout.write(
    `  ${''.padEnd(2)} ${'ID'.padEnd(26)} ${'STATUS'.padEnd(10)} ${'WORKFLOW'.padEnd(20)} ${'STEPS'.padEnd(6)} DURATION\n`,
  )
  for (const row of rows) {
    process.stdout.write(`${row}\n`)
  }

  return EXIT.OK
}
