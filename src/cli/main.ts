#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import {
  detectCi,
  isRunMode,
  type RunMode,
  RunModeError,
  type RunModeResolution,
  resolveRunMode,
  type WorkflowArgs,
} from '../core/index.ts'
import { createPlainHost, createTmuxHost, type Host, type PlainFormat } from '../hosts/index.ts'
import type { Clock } from '../services/clock/index.ts'
import type { ProcessService } from '../services/process/index.ts'
import type { RunId } from '../state/index.ts'
import { dryRunCmd } from './commands/dry-run.ts'
import { resumeCmd } from './commands/resume.ts'
import { runCmd } from './commands/run.ts'
import { runsCmd } from './commands/runs.ts'
import { statusCmd } from './commands/status.ts'
import { createDeps } from './deps.ts'
import { meetsMinimumTmuxVersion, probeTmuxVersion } from './detect-tmux.ts'

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
  SIGINT: 130,
  SIGTERM: 143,
} as const

// ---------------------------------------------------------------------------
// CliOpts — flag-level options forwarded from argv to each command handler.
// ---------------------------------------------------------------------------

export interface CliOpts {
  readonly mode: RunMode | undefined
  readonly format: PlainFormat
}

// ---------------------------------------------------------------------------
// HostFactory — command handlers own run-id creation but don't know how to
// pick a host. The entry point hands them a factory that resolves the mode
// once per invocation and builds the right Host implementation.
// ---------------------------------------------------------------------------

export interface HostFactoryArgs {
  readonly runId: RunId
  readonly workflowName: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly clock: Clock
}

export type HostFactory = (args: HostFactoryArgs) => Promise<Host>

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
  --mode <m>               plain | single-pane | two-pane (single-pane deferred to v2)
  --format <f>             text | json — plain mode only; json suppresses the banner
`

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export function parseArgv(argv: string[]): {
  command: string | undefined
  positional: string
  args: WorkflowArgs
  help: boolean
  mode: RunMode | undefined
  format: PlainFormat
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      prompt: { type: 'string' },
      mode: { type: 'string' },
      format: { type: 'string' },
      tmux: { type: 'boolean' },
      observe: { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  })

  if (values.tmux !== undefined) {
    throw new ArgvError('unknown flag "--tmux"; use --mode=two-pane')
  }
  if (values.observe !== undefined) {
    throw new ArgvError('unknown flag "--observe"; use --mode=two-pane')
  }

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

  const mode = parseModeFlag(values.mode)
  const format = parseFormatFlag(values.format)

  if (format === 'json' && mode !== undefined && mode !== 'plain') {
    throw new ArgvError(`--format=json is only valid with --mode=plain (got --mode=${mode})`)
  }

  return {
    command: positionals[0],
    positional: positionals[1] ?? '',
    args,
    help: values.help as boolean,
    mode,
    format,
  }
}

function parseModeFlag(raw: unknown): RunMode | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new ArgvError('--mode requires a value')
  if (!isRunMode(raw)) {
    throw new ArgvError(`unknown --mode=${raw}; expected plain | single-pane | two-pane`)
  }
  return raw
}

function parseFormatFlag(raw: unknown): PlainFormat {
  if (raw === undefined) return 'text'
  if (raw === 'text' || raw === 'json') return raw
  throw new ArgvError(`unknown --format=${String(raw)}; expected text | json`)
}

// ---------------------------------------------------------------------------
// Mode + host wiring
// ---------------------------------------------------------------------------

async function resolveMode(
  flag: RunMode | undefined,
  deps: ReturnType<typeof createDeps>,
): Promise<RunModeResolution> {
  const tmuxProbe = await probeTmuxVersion(deps.processService)
  const tmuxAvailable = tmuxProbe !== undefined
  const tmuxVersionOk = tmuxAvailable && meetsMinimumTmuxVersion(tmuxProbe)
  const tty = typeof process.stdout !== 'undefined' && process.stdout.isTTY === true
  const ci = detectCi(process.env)
  return resolveRunMode({
    ...(flag !== undefined ? { flag } : {}),
    ci,
    tty,
    tmuxAvailable,
    tmuxVersionOk,
  })
}

export function buildBanner(resolution: RunModeResolution): string {
  return `[orch] mode=${resolution.mode} (${resolution.source}: ${resolution.reason}) · --mode=... to override`
}

function makePlainHostFactory(format: PlainFormat, processService: ProcessService): HostFactory {
  return async (args) =>
    createPlainHost({
      stdout: args.stdout,
      stderr: args.stderr,
      format,
      clock: args.clock,
      runId: args.runId,
      processService,
    })
}

function makeTmuxHostFactory(processService: ProcessService): HostFactory {
  return (args) =>
    createTmuxHost({
      processService,
      clock: args.clock,
      runId: args.runId,
      workflowName: args.workflowName,
      stderr: args.stderr,
    })
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
    hostFactory: HostFactory,
  ) => Promise<number>
> = {
  run: runCmd,
  resume: resumeCmd,
  runs: commandWithoutHost(runsCmd),
  status: commandWithoutHost(statusCmd),
  'dry-run': commandWithoutHost(dryRunCmd),
}

type NoHostCmd = (
  deps: ReturnType<typeof createDeps>,
  positional: string,
  args: WorkflowArgs,
  opts: CliOpts,
) => Promise<number>

function commandWithoutHost(
  fn: NoHostCmd,
): (
  deps: ReturnType<typeof createDeps>,
  positional: string,
  args: WorkflowArgs,
  opts: CliOpts,
  _hostFactory: HostFactory,
) => Promise<number> {
  return (deps, positional, args, opts) => fn(deps, positional, args, opts)
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

  let resolution: RunModeResolution
  try {
    resolution = await resolveMode(parsed.mode, deps)
  } catch (err) {
    if (err instanceof RunModeError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(EXIT.CONFIG_ERROR)
    }
    throw err
  }

  if (parsed.format !== 'json') {
    process.stderr.write(`${buildBanner(resolution)}\n`)
  }

  const opts: CliOpts = { mode: resolution.mode, format: parsed.format }
  const hostFactory: HostFactory =
    resolution.mode === 'two-pane'
      ? makeTmuxHostFactory(deps.processService)
      : makePlainHostFactory(parsed.format, deps.processService)
  const code = await handler(deps, parsed.positional, parsed.args, opts, hostFactory)
  process.exit(code)
}

// Guard: only runs when this file is the entry point, not when imported by tests.
if (import.meta.main) {
  main()
}
