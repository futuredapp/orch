#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import type { WorkflowArgs } from '../core/index.ts'
import { dryRunCmd } from './commands/dry-run.ts'
import { resumeCmd } from './commands/resume.ts'
import { runCmd } from './commands/run.ts'
import { runsCmd } from './commands/runs.ts'
import { statusCmd } from './commands/status.ts'
import { createDeps } from './deps.ts'

export class ArgvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgvError'
  }
}

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
// CliOpts — flag-level options forwarded from argv to each command handler.
// ---------------------------------------------------------------------------

export interface CliOpts {
  readonly tmux: boolean
  readonly observe: boolean
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `Usage: orch <command> [options]

Commands:
  run <name> [prompt]      Run a workflow (optional inline prompt)
  resume [id] [prompt]     Resume a run; optional prompt overrides persisted args
  runs                     List recent runs
  status <id>              Show status of a run
  dry-run <name> [prompt]  Preflight check + first-step peek

Options:
  -h, --help               Show this help message
  --prompt <text>          Alias for the inline prompt positional
  --tmux                   Run steps inside a dedicated tmux session
  --observe                Show agent output in a tmux pane (implies --tmux)
`

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export function parseArgv(argv: string[]): {
  command: string | undefined
  positional: string
  args: WorkflowArgs
  help: boolean
  tmux: boolean
  observe: boolean
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      prompt: { type: 'string' },
      tmux: { type: 'boolean', default: false },
      observe: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  })

  if (positionals.length > 3) {
    throw new ArgvError(`Unexpected extra positional arguments: ${positionals.slice(3).join(' ')}`)
  }

  const inlinePrompt = positionals[2]
  const flagPrompt = typeof values.prompt === 'string' ? values.prompt : undefined

  if (inlinePrompt !== undefined && flagPrompt !== undefined) {
    throw new ArgvError('Cannot specify both a positional prompt and --prompt')
  }

  const prompt = flagPrompt ?? inlinePrompt
  const args: WorkflowArgs = prompt !== undefined ? { prompt } : {}

  const observe = values.observe === true
  const tmux = observe || values.tmux === true

  return {
    command: positionals[0],
    positional: positionals[1] ?? '',
    args,
    help: values.help as boolean,
    tmux,
    observe,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<
  string,
  (
    deps: ReturnType<typeof createDeps>,
    positional: string,
    args: WorkflowArgs,
    opts: CliOpts,
  ) => Promise<number>
> = {
  run: runCmd,
  resume: resumeCmd,
  runs: runsCmd,
  status: statusCmd,
  'dry-run': dryRunCmd,
}

async function main(): Promise<never> {
  const argv = Bun.argv.slice(2)

  let parsed: ReturnType<typeof parseArgv>
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    if (err instanceof ArgvError) {
      process.stderr.write(`${err.message}\n\n${HELP}`)
      process.exit(EXIT.CONFIG_ERROR)
    }
    throw err
  }

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
  const opts: CliOpts = { tmux: parsed.tmux, observe: parsed.observe }
  const code = await handler(deps, parsed.positional, parsed.args, opts)
  process.exit(code)
}

// Guard: only runs when this file is the entry point, not when imported by tests.
if (import.meta.main) {
  main()
}
