#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { dryRunCmd } from './commands/dry-run.ts'
import { resumeCmd } from './commands/resume.ts'
import { runCmd } from './commands/run.ts'
import { runsCmd } from './commands/runs.ts'
import { statusCmd } from './commands/status.ts'
import { createDeps } from './deps.ts'

// ---------------------------------------------------------------------------
// Exit codes — exported so tests and docs stay in sync
// ---------------------------------------------------------------------------

export const EXIT = {
  OK: 0,
  STEP_FAILURE: 1,
  CONFIG_ERROR: 2,
  CANNOT_RESUME: 3,
} as const

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `Usage: orch <command> [options]

Commands:
  run <name>        Run a workflow by name
  resume [id]       Resume the latest resumable run (or a specific run)
  runs              List recent runs
  status <id>       Show status of a run
  dry-run <name>    Preflight check + first-step peek

Options:
  -h, --help        Show this help message
`

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export function parseArgv(argv: string[]): {
  command: string | undefined
  positional: string
  help: boolean
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: false,
    allowPositionals: true,
  })

  return {
    command: positionals[0],
    positional: positionals[1] ?? '',
    help: values.help as boolean,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<
  string,
  (deps: ReturnType<typeof createDeps>, positional: string) => Promise<number>
> = {
  run: runCmd,
  resume: resumeCmd,
  runs: runsCmd,
  status: statusCmd,
  'dry-run': dryRunCmd,
}

async function main(): Promise<never> {
  const argv = Bun.argv.slice(2)
  const parsed = parseArgv(argv)

  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(EXIT.OK)
  }

  if (parsed.command === undefined) {
    process.stderr.write(HELP)
    process.exit(EXIT.CONFIG_ERROR)
  }

  const handler = COMMANDS[parsed.command]
  if (handler === undefined) {
    process.stderr.write(`Unknown command: ${parsed.command}\n\n${HELP}`)
    process.exit(EXIT.CONFIG_ERROR)
  }

  const deps = createDeps(process.cwd())
  const code = await handler(deps, parsed.positional)
  process.exit(code)
}

// Guard: only runs when this file is the entry point, not when imported by tests.
if (import.meta.main) {
  main()
}
