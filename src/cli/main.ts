#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { ConfigLoadError, loadConfig } from '../config/index.ts'
import {
  detectCi,
  isRunMode,
  type RunMode,
  RunModeError,
  type RunModeResolution,
  resolveRunMode,
  type WorkflowArgs,
} from '../core/index.ts'
import {
  createHostRegistry,
  type HostFactory,
  type HostFactoryInputs,
  type PlainFormat,
  registerBuiltinHosts,
} from '../hosts/index.ts'
import type { ProcessService } from '../services/process/index.ts'
import { dryRunCmd } from './commands/dry-run.ts'
import { logsCmd } from './commands/logs.ts'
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
  /**
   * `--no-attach` — skip auto-attach in two-pane mode. CLI still creates the
   * tmux session and prints the "attach with …" hint; workflow runs to
   * completion without taking the TTY. Use for CI, screenshot scripts, and
   * users who want to attach manually from a second terminal.
   */
  readonly noAttach: boolean
}

// ---------------------------------------------------------------------------
// HostFactory — command handlers own run-id creation but don't know how to
// pick a host. The entry point hands them a factory (resolved from the host
// registry) that takes per-invocation args and returns the right Host.
// ---------------------------------------------------------------------------

export type { HostFactory, HostFactoryInputs as HostFactoryArgs }

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `Usage: orch <command> [options]

Commands:
  run <name> [prompt]      Run a workflow (optional inline prompt)
  resume [id] [prompt]     Resume a run; optional prompt overrides persisted args
  runs                     List recent runs
  status <id>              Show status of a run
  logs <runId>             Stream the per-step transcript for a run
  dry-run <name> [prompt]  Preflight check + first-step peek

Options:
  -h, --help               Show this help message
  --prompt <text>          Alias for the inline prompt positional
  --mode <m>               plain | single-pane | two-pane (single-pane deferred to v2)
  --format <f>             text | json — plain mode only; json suppresses the banner
  --no-attach              two-pane only: skip auto-attach; print attach hint and keep running
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
  noAttach: boolean
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      prompt: { type: 'string' },
      mode: { type: 'string' },
      format: { type: 'string' },
      'no-attach': { type: 'boolean', default: false },
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
  const noAttach = values['no-attach'] === true

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
    noAttach,
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
  allowHeadlessTwoPane: boolean,
): Promise<RunModeResolution> {
  const tmuxProbe = await probeTmuxVersion(deps.processService)
  const tmuxAvailable = tmuxProbe !== undefined
  const tmuxVersionOk = tmuxAvailable && meetsMinimumTmuxVersion(tmuxProbe)
  const tty = typeof process.stdout !== 'undefined' && process.stdout.isTTY === true
  const ci = detectCi(process.env)
  const configDefault = flag === undefined ? await loadConfigDefaultMode(deps.cwd) : undefined
  return resolveRunMode({
    ...(flag !== undefined ? { flag } : {}),
    ...(configDefault !== undefined ? { configDefault } : {}),
    ci,
    tty,
    tmuxAvailable,
    tmuxVersionOk,
    allowHeadlessTwoPane,
  })
}

async function loadConfigDefaultMode(
  cwd: ReturnType<typeof createDeps>['cwd'],
): Promise<RunMode | undefined> {
  try {
    const cfg = await loadConfig(cwd)
    return cfg.defaultMode
  } catch (err) {
    // A missing/invalid config is not fatal for mode resolution — commands
    // that actually need the config will surface the error. Falling through
    // preserves the "orch commands that don't read config keep working"
    // contract (runs, status).
    if (err instanceof ConfigLoadError) return undefined
    throw err
  }
}

export function buildBanner(resolution: RunModeResolution): string {
  return `[orch] mode=${resolution.mode} (${resolution.source}: ${resolution.reason}) · --mode=... to override`
}

function pickHostFactory(
  mode: RunMode,
  format: PlainFormat,
  processService: ProcessService,
  noAttach: boolean,
): HostFactory {
  const registry = createHostRegistry()
  registerBuiltinHosts(registry, {
    processService,
    format,
    tmuxOverrides: noAttach ? { skipAttach: true } : undefined,
  })
  return registry.resolve(mode)
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
  logs: commandWithoutHost(logsCmd),
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
    resolution = await resolveMode(parsed.mode, deps, parsed.noAttach)
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

  const opts: CliOpts = {
    mode: resolution.mode,
    format: parsed.format,
    noAttach: parsed.noAttach,
  }
  const hostFactory = pickHostFactory(
    resolution.mode,
    parsed.format,
    deps.processService,
    parsed.noAttach,
  )
  const code = await handler(deps, parsed.positional, parsed.args, opts, hostFactory)
  process.exit(code)
}

// Guard: only runs when this file is the entry point, not when imported by tests.
if (import.meta.main) {
  main()
}
