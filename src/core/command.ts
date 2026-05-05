// ---------------------------------------------------------------------------
// command() — first-class workflow primitive for arbitrary shell commands.
// ---------------------------------------------------------------------------
//
// `await run(command(name, opts))` spawns `argv` via `ProcessService.spawn`,
// streams stdout/stderr live to the active host pane (and to the per-step
// log files), and returns `{ exitCode, stdout, stderr, durationMs }`. The
// step kind `'command'` joins `'agent' | 'commit' | 'worktree' | 'ask'` in
// the discriminated `StepConfig` union.
//
// Modeled on `src/core/worktree.ts` for shape parity. The brainstorm and
// plan live at:
//   docs/brainstorms/2026-05-05-custom-command-step-brainstorm.md
//   docs/plans/2026-05-05-feat-command-step-plan.md

import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { Host } from '../hosts/host.ts'
import type { SessionLogger, StepSpan } from '../observability/index.ts'
import { envKeys as envKeyList, redactReproduceCommand } from '../observability/index.ts'
import type { Clock, ProcessService } from '../services/index.ts'
import { mergeEnv, path as toPath } from '../services/index.ts'
import type { StepEntry } from '../state/index.ts'
import { StepError } from './errors.ts'
import type { Step } from './step.ts'
import type { Path, StepName } from './types.ts'
import { stepName } from './types.ts'
import type { PaneRole } from './view.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommandStepConfig {
  readonly kind: 'command'
  readonly argv: readonly string[]
  /** Required. No default — surfaces the policy at the workflow-author's eye. */
  readonly onFailure: 'halt' | 'continue'
  readonly cwd?: Path
  readonly env?: Readonly<Record<string, string>>
  /** Default 'right'. Routes output to the chosen pane on two-pane hosts. */
  readonly pane?: PaneRole
  /** Run the command but emit no host output (logs still capture). */
  readonly silent?: boolean
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface CommandOpts {
  readonly argv: readonly string[]
  readonly onFailure: 'halt' | 'continue'
  readonly cwd?: Path
  readonly env?: Readonly<Record<string, string>>
  readonly pane?: PaneRole
  readonly silent?: boolean
}

/**
 * Runtime schema for `CommandResult`. Used by `onCacheHit` to validate
 * cached values loaded from `state.json`.
 */
export const CommandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
})

const COMMAND_PREFIX = 'command:'
const MAX_STEP_NAME_LENGTH = 128
const MAX_SLUG_LENGTH = MAX_STEP_NAME_LENGTH - COMMAND_PREFIX.length

/**
 * Slugifies a command name into a step-name-safe string.
 * Slug rules mirror src/core/commit.ts:18-22 and src/core/worktree.ts:53-58 —
 * keep in sync.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Build a command step that runs `argv` via `ProcessService.spawn`, streams
 * output live to the active host pane, and returns the captured result.
 *
 * Cwd defaults to the active worktree (if any) else the workflow's cwd;
 * override with `cwd`. Env passes through `process.env`; the `env` option
 * layers on top (wins last) — matches the runner env policy.
 *
 * Failure policy is required: `'halt'` throws `StepError` on non-zero exit;
 * `'continue'` returns the result so downstream steps can inspect it.
 *
 * Memoization is by step name: a successful run persists `CommandResult` and
 * resume re-uses it without re-spawning. Argv is NOT part of the cache key —
 * authors who want to discriminate on argv pass distinct names.
 *
 * Example:
 *   const TESTS = command('tests', { argv: ['bun', 'test'], onFailure: 'continue' })
 *   const r = await run(TESTS)
 *   if (r.exitCode !== 0) await run(FIX, { extraContext: { stdout: tail(r.stdout, 200) } })
 */
export function command(name: string, opts: CommandOpts): Step<CommandResult> {
  validateName(name)
  validateArgv(opts.argv)
  validateOnFailure(opts.onFailure)
  if (opts.cwd !== undefined) validateCwd(opts.cwd)
  if (opts.env !== undefined) validateEnv(opts.env)
  if (opts.pane !== undefined) validatePane(opts.pane)

  const slug = slugify(name)
  if (slug.length === 0) {
    throw new Error(`command() name "${name}" produces an empty slug — use alphanumeric characters`)
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `command() name "${name}" sanitizes to ${slug.length} chars; max is ${MAX_SLUG_LENGTH}`,
    )
  }

  const stepKey = stepName(`${COMMAND_PREFIX}${slug}`)

  const config: CommandStepConfig = {
    kind: 'command' as const,
    argv: Object.freeze([...opts.argv]),
    onFailure: opts.onFailure,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: Object.freeze({ ...opts.env }) } : {}),
    ...(opts.pane !== undefined ? { pane: opts.pane } : {}),
    ...(opts.silent === true ? { silent: true } : {}),
  }

  return Object.freeze({ name: stepKey, config })
}

/**
 * Trim a captured stream to the last `n` lines. A trailing newline (if
 * present in the input) is preserved. Returns `''` when `n <= 0`.
 *
 * Robust to CRLF: line splits on `\n` and the trailing `\r` is preserved
 * inside each retained line — same shape every consumer already sees from
 * the raw capture.
 */
export function tail(text: string, n: number): string {
  if (n <= 0) return ''
  if (text.length === 0) return text

  const hasTrailingNewline = text.endsWith('\n')
  const body = hasTrailingNewline ? text.slice(0, -1) : text
  const lines = body.split('\n')
  if (lines.length <= n) return text

  const kept = lines.slice(-n).join('\n')
  return hasTrailingNewline ? `${kept}\n` : kept
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateName(name: string): void {
  if (typeof name !== 'string') {
    throw new Error('command() name must be a string')
  }
  if (name.length === 0) {
    throw new Error('command() name must not be empty')
  }
  if (name.trim().length === 0) {
    throw new Error('command() name must not be whitespace-only')
  }
  if (name.startsWith(COMMAND_PREFIX)) {
    throw new Error(
      `command() name "${name}" must not begin with the reserved "${COMMAND_PREFIX}" prefix — ` +
        'the factory adds it for you',
    )
  }
}

function validateArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) && !isReadonlyArray(argv)) {
    throw new Error('command() argv must be an array')
  }
  if (argv.length === 0) {
    throw new Error('command() argv must not be empty')
  }
  const head = argv[0]
  if (typeof head !== 'string' || head.length === 0) {
    throw new Error('command() argv[0] must be a non-empty string')
  }
  if (head.includes('\0')) {
    throw new Error('command() argv[0] must not contain null bytes')
  }
  if (head.includes('\n') || head.includes('\r')) {
    throw new Error('command() argv[0] must not contain newline characters')
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (typeof arg !== 'string') {
      throw new Error(`command() argv[${i}] must be a string`)
    }
    if (arg.includes('\0')) {
      throw new Error(`command() argv[${i}] must not contain null bytes`)
    }
  }
}

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function validateOnFailure(policy: unknown): void {
  if (policy !== 'halt' && policy !== 'continue') {
    throw new Error(
      `command() onFailure must be 'halt' or 'continue' (got ${JSON.stringify(policy)})`,
    )
  }
}

function validateCwd(cwd: string): void {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('command() cwd must be a non-empty string')
  }
  if (cwd.includes('\0')) {
    throw new Error('command() cwd must not contain null bytes')
  }
  if (cwd.includes('\n') || cwd.includes('\r')) {
    throw new Error('command() cwd must not contain newline characters')
  }
}

function validateEnv(env: Readonly<Record<string, string>>): void {
  if (env === null || typeof env !== 'object') {
    throw new Error('command() env must be an object')
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') {
      throw new Error(`command() env["${k}"] must be a string`)
    }
    if (v.includes('\0')) {
      throw new Error(`command() env["${k}"] must not contain null bytes`)
    }
    if (v.includes('\n') || v.includes('\r')) {
      throw new Error(`command() env["${k}"] must not contain newline characters`)
    }
  }
}

function validatePane(pane: PaneRole): void {
  if (pane !== 'left' && pane !== 'right') {
    throw new Error(`command() pane must be 'left' or 'right' (got ${JSON.stringify(pane)})`)
  }
}

// ---------------------------------------------------------------------------
// runCommandStep — executor branch invoked from src/core/workflow.ts
// ---------------------------------------------------------------------------

export interface CommandStepDeps {
  readonly processService: ProcessService
  readonly clock: Clock
  readonly host: Host
  readonly logger?: SessionLogger
  /** Optional step span for lifecycle / spawn / session log fan-out. */
  readonly stepSpan?: StepSpan
}

export interface CommandStepOverrides {
  readonly prompt?: string
  readonly extraContext?: unknown
  readonly extraPrompt?: string
}

/**
 * Resolve `config.cwd` against the workflow's current cwd:
 * absolute paths used verbatim, relative paths resolved against `currentCwd`.
 * When `config.cwd` is absent, `currentCwd` wins. Mirrors how
 * `worktree.ts:resolveTargetPath` resolves its `target` option.
 */
function resolveCwd(currentCwd: Path, override: Path | undefined): Path {
  if (override === undefined) return currentCwd
  return isAbsolute(override) ? override : toPath(resolve(currentCwd, override))
}

export async function runCommandStep(
  deps: CommandStepDeps,
  config: CommandStepConfig,
  key: StepName,
  cwd: Path,
  overrides: CommandStepOverrides | undefined,
): Promise<{ value: CommandResult; entry: StepEntry }> {
  rejectAgentOverrides(key, overrides)

  const startedAt = deps.clock.now()
  const resolvedCwd = resolveCwd(cwd, config.cwd)
  const env = mergeEnv(process.env, {}, config.env ?? {})
  const pane: PaneRole = config.pane ?? 'right'
  const isSilent = config.silent === true

  // Per-step log sinks. Mirrors agent steps' raw_output / raw_stderr layout
  // but under `commands/<step>/` so cold readers can grep by kind without
  // crossing into the agent transcript folder.
  const stdoutSink = deps.logger?.streamSink(`commands/${key}/stdout.log`, {
    truncateOnOpen: true,
  })
  const stderrSink = deps.logger?.streamSink(`commands/${key}/stderr.log`, {
    truncateOnOpen: true,
  })

  const handle = deps.processService.spawn({
    argv: [...config.argv],
    cwd: resolvedCwd,
    env,
    tag: 'command',
  })

  const stdoutCapture: string[] = []
  const stderrCapture: string[] = []

  const fanout = (stream: 'stdout' | 'stderr', line: string): void => {
    const cap = stream === 'stdout' ? stdoutCapture : stderrCapture
    cap.push(line)
    const sink = stream === 'stdout' ? stdoutSink : stderrSink
    void sink?.write(`${line}\n`).catch(() => {})
    if (!isSilent) {
      deps.host.onCommandLine({ stream, line, step: key, pane })
    }
  }

  const stdoutDone = drainStream(handle.stdout, (line) => fanout('stdout', line))
  const stderrDone = drainStream(handle.stderr, (line) => fanout('stderr', line))
  const { exitCode } = await handle.wait()
  await Promise.all([stdoutDone, stderrDone])
  if (stdoutSink !== undefined) await stdoutSink.close()
  if (stderrSink !== undefined) await stderrSink.close()

  const durationMs = deps.clock.now() - startedAt
  const value: CommandResult = {
    exitCode,
    stdout: joinLines(stdoutCapture),
    stderr: joinLines(stderrCapture),
    durationMs,
  }

  // Best-effort spawn record. Mirrors logAgentSpawn() in workflow.ts so
  // `orch logs` shows commands alongside agents in spawns.ndjson.
  if (deps.stepSpan !== undefined) {
    void deps.stepSpan
      .append('spawns', {
        runnerName: 'command',
        mode: 'autonomous',
        argv: [...config.argv],
        envKeys: envKeyList(env),
        cwd: resolvedCwd,
        exitCode,
        durationMs,
        reproduce: buildReproduce(resolvedCwd, env, config.argv),
      })
      .catch(() => {})
  }

  await writeCommandSession(deps.logger, deps.stepSpan, {
    stepName: key,
    argv: config.argv,
    env,
    cwd: resolvedCwd,
    exitCode,
    durationMs,
    stdoutLineCount: stdoutCapture.length,
    stderrLineCount: stderrCapture.length,
  })

  if (exitCode !== 0 && config.onFailure === 'halt') {
    throw new StepError(key, exitCode, `command exited ${exitCode}`)
  }

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    mode: 'autonomous',
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}

function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n`
}

function rejectAgentOverrides(key: StepName, overrides: CommandStepOverrides | undefined): void {
  if (overrides?.prompt !== undefined) {
    throw new Error(`Command step "${key}" does not accept prompt overrides`)
  }
  if (overrides?.extraContext !== undefined) {
    throw new Error(`Command step "${key}" does not accept extraContext overrides`)
  }
  if (overrides?.extraPrompt !== undefined) {
    throw new Error(`Command step "${key}" does not accept extraPrompt overrides`)
  }
}

async function drainStream(
  stream: AsyncIterable<string>,
  onLine: (line: string) => void,
): Promise<void> {
  for await (const line of stream) {
    onLine(line)
  }
}

function buildReproduce(
  cwd: Path,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): string {
  const envParts = Object.keys(env)
    .sort()
    .map((k) => `${k}=${shellQuote(env[k] ?? '')}`)
  const quotedArgv = argv.map((a) => shellQuote(a)).join(' ')
  const envPrefix = envParts.length > 0 ? `${envParts.join(' ')} ` : ''
  return redactReproduceCommand(`cd ${shellQuote(cwd)} && ${envPrefix}${quotedArgv}`)
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

interface CommandSessionRecord {
  readonly stepName: StepName
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: Path
  readonly exitCode: number
  readonly durationMs: number
  readonly stdoutLineCount: number
  readonly stderrLineCount: number
}

async function writeCommandSession(
  logger: SessionLogger | undefined,
  stepSpan: StepSpan | undefined,
  r: CommandSessionRecord,
): Promise<void> {
  if (logger === undefined || stepSpan === undefined) return
  const body = JSON.stringify(
    {
      stepName: r.stepName,
      stepSpanId: stepSpan.stepSpanId,
      kind: 'command',
      argv: [...r.argv],
      envKeys: envKeyList(r.env),
      cwd: r.cwd,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdoutLineCount: r.stdoutLineCount,
      stderrLineCount: r.stderrLineCount,
      outputs: COMMAND_OUTPUTS,
      reproduce: redactReproduceCommand(buildReproduce(r.cwd, r.env, r.argv)),
    },
    null,
    2,
  )
  await logger.writeFile(`commands/${r.stepName}/session.json`, body).catch(() => {})
}

const COMMAND_OUTPUTS = Object.freeze({
  stdout: 'stdout.log',
  stderr: 'stderr.log',
})
