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
import { toClaudeTranscriptLines } from '../runners/index.ts'
import type { ProcessService } from '../services/process/index.ts'
import { BUILTIN_NAMES, BUILTIN_PREFIX } from '../workflows/index.ts'
import { dryRunCmd } from './commands/dry-run.ts'
import { initCmd } from './commands/init.ts'
import { logsCmd } from './commands/logs.ts'
import { newCmd } from './commands/new.ts'
import { resumeCmd } from './commands/resume.ts'
import { retryCmd } from './commands/retry.ts'
import { runCmd } from './commands/run.ts'
import { runsCmd } from './commands/runs.ts'
import { statusCmd } from './commands/status.ts'
import { typesCmd } from './commands/types.ts'
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
  /**
   * `--debug` — turn on heavy captures in `.orch/state/<runId>/logs/` (raw
   * agent stdout/stderr, tmux pipe-pane, subprocess spawns, orch internal
   * trace). All-or-nothing. Defaults to `ORCH_DEBUG=1` in the environment.
   */
  readonly debug: boolean
  /**
   * Run-level interactivity axis (orthogonal to mode). 'noninteractive'
   * resolves `ask()` steps from declared defaults instead of rendering a
   * prompt. Sourced from `--interactive` / `--noninteractive` flags or
   * `ORCH_NONINTERACTIVE=1` env var. NOT persisted to state.
   */
  readonly interactivity: 'interactive' | 'noninteractive'
  /**
   * `--latest` — `orch logs` only. Resolve the runId to the most recent run
   * at command time (snapshot — does not switch if a new run starts during
   * tail). Mutually exclusive with a positional runId.
   */
  readonly latest: boolean
  /**
   * `--step <name>` — `orch logs` only. Print only the named step's
   * transcript. Exact match; no-match exits 2 with the list of valid step
   * names. Required when `--follow` is set.
   */
  readonly step: string | undefined
  /**
   * `--follow`, `-f` — `orch logs` only. Tail the named step's transcript
   * until the run reaches a terminal status (completed, failed, cancelled)
   * or SIGINT. Requires `--step`.
   */
  readonly follow: boolean
  /**
   * `--watch` — `orch types` only. Keep the codegen loop alive and
   * regenerate sidecars on every prompt-file change. SIGINT exits cleanly.
   */
  readonly watch: boolean
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

const BUILTINS_LINE = BUILTIN_NAMES.map((n) => `${BUILTIN_PREFIX}${n}`).join(', ')

const HELP = `Usage: orch <command> [options]

Commands:
  init                     Scaffold a fresh .orch/ in this project
  new <name>               Create a new workflow file under .orch/workflows/
  run <name> [prompt]      Run a workflow (optional inline prompt)
                           Built-ins (no .orch/workflows/ needed): ${BUILTINS_LINE}
  resume [id] [prompt]     Resume a run; optional prompt overrides persisted args
  retry <id> [prompt]      Retry a failed run: re-run the failed step and continue to completion
  runs                     List recent runs
  status <id>              Show status of a run
  logs <runId>             Stream the per-step transcript for a run
  logs --latest            Stream the most recent run's transcript
  dry-run <name> [prompt]  Preflight check + first-step peek
  types [--watch]          Generate .d.ts sidecars for prompt files (--watch keeps a regen loop alive)

Options:
  -h, --help               Show this help message
  --prompt <text>          Alias for the inline prompt positional
  --mode <m>               plain | single-pane | two-pane (single-pane deferred to v2)
  --format <f>             text | json — plain mode only; json suppresses the banner
  --no-attach              two-pane only: skip auto-attach; print attach hint and keep running
  --debug                  turn on heavy session logs (agent stdout/stderr, tmux pipe-pane, subprocess spawns, orch.log)
  --interactive            ask() prompts render normally (default); cancel via Ctrl-C / Ctrl-D
  --noninteractive         ask() resolves declared defaults (CI, scheduled runs); errors if no default

Logs options (orch logs):
  --latest                 Resolve <runId> to the most recent run (snapshot at command time)
  --step <name>            Print only the named step's transcript (exact match)
  -f, --follow             Tail the named step until completed/failed/cancelled or SIGINT (requires --step)

Types options (orch types):
  --watch                  Keep a regen loop alive that refreshes sidecars on prompt-file change (Ctrl-C to exit)
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
  debug: boolean
  interactivity: 'interactive' | 'noninteractive'
  latest: boolean
  step: string | undefined
  follow: boolean
  watch: boolean
} {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      prompt: { type: 'string' },
      mode: { type: 'string' },
      format: { type: 'string' },
      'no-attach': { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
      interactive: { type: 'boolean' },
      noninteractive: { type: 'boolean' },
      tmux: { type: 'boolean' },
      observe: { type: 'boolean' },
      // `orch logs` flags. Surfaced via parseArgv so `logsCmd` reads them
      // off `CliOpts` like every other CLI option.
      latest: { type: 'boolean', default: false },
      step: { type: 'string' },
      follow: { type: 'boolean', short: 'f', default: false },
      // `orch types --watch` — keep the sidecar codegen loop alive.
      watch: { type: 'boolean', default: false },
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
  const debug = values.debug === true || process.env.ORCH_DEBUG === '1'
  const interactivity = parseInteractivityFlags(values)

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
    debug,
    interactivity,
    latest: values.latest === true,
    step: typeof values.step === 'string' ? values.step : undefined,
    follow: values.follow === true,
    watch: values.watch === true,
  }
}

function parseInteractivityFlags(values: {
  interactive?: unknown
  noninteractive?: unknown
}): 'interactive' | 'noninteractive' {
  const interactive = values.interactive === true
  const noninteractive = values.noninteractive === true
  if (interactive && noninteractive) {
    throw new ArgvError('Cannot specify both --interactive and --noninteractive')
  }
  if (noninteractive) return 'noninteractive'
  if (interactive) return 'interactive'
  return process.env.ORCH_NONINTERACTIVE === '1' ? 'noninteractive' : 'interactive'
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
    const loaded = await loadConfig(cwd)
    return loaded.config.defaultMode
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

/**
 * Two-pane non-JSON-only hint pointing at in-pane scroll first and the
 * live-progress command as the power-user fallback. Returns `undefined`
 * for any other combination so the caller can unconditionally
 * `if (hint) write(hint)` without re-checking gates.
 *
 * Smart-wheel scrollback (right pane) and the Ink keymap (left pane) are
 * the primary scroll surfaces in two-pane mode; `orch logs --latest
 * --follow` remains the durable fallback for users who want to watch
 * progress from a second terminal. Plain mode and JSON output don't get
 * the hint — plain prints the transcript inline; JSON suppresses the
 * banner entirely.
 */
export function buildTwoPaneLogsHint(
  resolution: RunModeResolution,
  format: PlainFormat,
): string | undefined {
  if (format === 'json') return undefined
  if (resolution.mode !== 'two-pane') return undefined
  return (
    '[orch] scroll: wheel (right) or j/k/PgUp/PgDn/End (left) · ' +
    'orch logs --latest --follow --step <step-name>'
  )
}

function pickHostFactory(
  mode: RunMode,
  format: PlainFormat,
  processService: ProcessService,
  noAttach: boolean,
  basePath: import('../services/types.ts').Path,
): HostFactory {
  const registry = createHostRegistry()
  // Phase A pragma (mirrors `cli/commands/logs.ts`'s `toClaudeTranscriptLines`
  // call): persisted NDJSON doesn't carry a runner tag yet, so we default the
  // ⏎-to-inspect renderer to Claude's. Phase E swaps this for a runner-
  // registry dispatch keyed off `state.json`.
  //
  // The interactive-resume `resumeRegistry` is per-workflow correct already —
  // run.ts / resume.ts each construct a live `ResumeRegistry` per invocation
  // and pass the same reference into both `hostFactory({...})` and `wfDeps`,
  // so the host reads what the executor writes in this process only. No
  // global state, no module singleton.
  const tmuxOverrides = {
    basePath,
    transcriptRenderer: toClaudeTranscriptLines,
    ...(noAttach ? { skipAttach: true as const } : {}),
  }
  registerBuiltinHosts(registry, {
    processService,
    format,
    tmuxOverrides,
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
  retry: retryCmd,
  runs: commandWithoutHost(runsCmd),
  status: commandWithoutHost(statusCmd),
  logs: commandWithoutHost(logsCmd),
  'dry-run': commandWithoutHost(dryRunCmd),
  init: commandWithoutHost(initCmd),
  new: commandWithoutHost(newCmd),
  types: commandWithoutHost(typesCmd),
}

// Commands that do not read `orch.config.ts`, do not pick a run mode, and
// must not print the `[orch] mode=...` banner. `init` is the bootstrap step
// (no config yet); `new` only mutates files under `.orch/` and does not
// dispatch any workflow.
const CONFIG_FREE_COMMANDS: ReadonlySet<string> = new Set(['init', 'new'])

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

  const deps = createDeps(process.cwd(), { debug: parsed.debug })

  // Config-free commands (`init`, `new`) bootstrap or mutate `.orch/`
  // contents and must not depend on `orch.config.ts`, run-mode resolution,
  // or the `[orch] mode=...` banner. They are dispatched with a minimal
  // `CliOpts` and a placeholder `HostFactory` that throws if a future bug
  // makes them reach for it.
  if (CONFIG_FREE_COMMANDS.has(parsed.command)) {
    const opts: CliOpts = {
      mode: undefined,
      format: parsed.format,
      noAttach: false,
      debug: parsed.debug,
      interactivity: parsed.interactivity,
      latest: false,
      step: undefined,
      follow: false,
      watch: false,
    }
    const forbiddenHostFactory: HostFactory = async () => {
      throw new Error(
        `Internal error: ${parsed.command} must not use HostFactory (config-free command).`,
      )
    }
    const code = await handler(deps, parsed.positional, parsed.args, opts, forbiddenHostFactory)
    process.exit(code)
  }

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
    const hint = buildTwoPaneLogsHint(resolution, parsed.format)
    if (hint !== undefined) process.stderr.write(`${hint}\n`)
  }

  const opts: CliOpts = {
    mode: resolution.mode,
    format: parsed.format,
    noAttach: parsed.noAttach,
    debug: parsed.debug,
    interactivity: parsed.interactivity,
    latest: parsed.latest,
    step: parsed.step,
    follow: parsed.follow,
    watch: parsed.watch,
  }
  const hostFactory = pickHostFactory(
    resolution.mode,
    parsed.format,
    deps.processService,
    parsed.noAttach,
    deps.statePath,
  )
  const code = await handler(deps, parsed.positional, parsed.args, opts, hostFactory)
  process.exit(code)
}

// Guard: only runs when this file is the entry point, not when imported by tests.
//
// NOTE: terminal-mode reset on hard exit was previously installed here as a
// global `process.on('exit', ...)` backstop. That fired on every exit path,
// including `--mode=plain` and the pre-host error paths (e.g.
// `--mode=single-pane` deferral, missing tmux on `--mode=two-pane`). Apple
// Terminal and iTerm2 in some configs interpret the alt-screen-exit byte
// (`\x1b[?1049l`) as a screen-buffer toggle rather than a state-set, which
// wiped the user's visible terminal — including the error message just
// written to stderr. The backstop now lives inside `createTmuxHost` (the
// only host that actually sets those modes) so it never fires on paths that
// don't need it.
if (import.meta.main) {
  main()
}
