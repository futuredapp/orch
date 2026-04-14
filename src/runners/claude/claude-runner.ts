import { z } from 'zod'
import type { Runner, RunnerCommand, RunnerContext, TerminalEvent } from '../types.ts'
import { defineRunner } from '../types.ts'

// ---------------------------------------------------------------------------
// Zod schemas — corrected against real Claude CLI v2.1.101 / SDK v0.2.101
// ---------------------------------------------------------------------------

const ClaudeUsage = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_read_input_tokens: z.number(),
  })
  .passthrough()

const ClaudeResultSuccess = z
  .object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    result: z.string(),
    session_id: z.string(),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.literal(false),
    num_turns: z.number(),
    total_cost_usd: z.number(),
    usage: ClaudeUsage,
    structured_output: z.unknown().optional(),
  })
  .passthrough()

// Claude CLI emits `subtype:'success'` + `is_error:true` for some failure
// modes (e.g. `--bare` + missing ANTHROPIC_API_KEY surfaces as a "success"
// envelope whose `result` field carries "Not logged in · Please run /login").
// Treat these as terminal errors and surface `result` as the message.
const ClaudeResultSuccessErrored = z
  .object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    result: z.string(),
    session_id: z.string(),
    duration_ms: z.number(),
    is_error: z.literal(true),
  })
  .passthrough()

const ClaudeResultError = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    session_id: z.string(),
    duration_ms: z.number(),
    is_error: z.literal(true),
    errors: z.array(z.string()),
  })
  .passthrough()

export type ClaudeResultSuccessT = z.infer<typeof ClaudeResultSuccess>
export type ClaudeResultErrorT = z.infer<typeof ClaudeResultError>

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeOptions {
  readonly model?: string
  readonly maxTurns?: number
  readonly bare?: boolean
  readonly flags?: readonly string[]
}

// ---------------------------------------------------------------------------
// Environment allowlist
// ---------------------------------------------------------------------------

const CLAUDE_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'SHELL',
  'USER',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  // TERM/COLORTERM carry terminal capability info used by Ink/chalk/supports-color
  // inside the Claude CLI. Without them, even a forced-color mode can't pick the
  // right ANSI level.
  'TERM',
  'COLORTERM',
] as const

// processEnv is injected for testability; the `process.env` default only
// activates inside the production call path (see buildCommand below).
export function buildClaudeEnv(
  ctxEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of CLAUDE_ENV_ALLOWLIST) {
    const val = processEnv[key]
    if (val !== undefined) base[key] = val
  }
  for (const [key, val] of Object.entries(processEnv)) {
    if ((key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) && val !== undefined) {
      base[key] = val
    }
  }
  // Allowlist wins over ctxEnv: a caller cannot override PATH/HOME/etc.
  return { ...ctxEnv, ...base }
}

// Flags that would let a caller escape the sandbox or inject arbitrary
// config. Denied whether they appear in `flags` or `ctx.extraArgs`.
const CLAUDE_FLAG_DENYLIST = [
  '--dangerously-skip-permissions',
  '--settings',
  '--mcp-config',
] as const

function assertFlagAllowed(flag: string): void {
  for (const deny of CLAUDE_FLAG_DENYLIST) {
    if (flag === deny || flag.startsWith(`${deny}=`)) {
      throw new Error(`claude(): flag "${flag}" is on the denylist`)
    }
  }
}

// ---------------------------------------------------------------------------
// NDJSON parser — two-tier: terminal result envelope vs generic passthrough
// ---------------------------------------------------------------------------

function parseResultEnvelope(raw: unknown): TerminalEvent {
  const successResult = ClaudeResultSuccess.safeParse(raw)
  if (successResult.success) {
    return { kind: 'terminal', type: 'turn-complete', data: successResult.data }
  }

  // "success" envelope flagged as error — carries the message in `result`.
  const erroredSuccess = ClaudeResultSuccessErrored.safeParse(raw)
  if (erroredSuccess.success) {
    return {
      kind: 'terminal',
      type: 'error',
      message: erroredSuccess.data.result,
      data: erroredSuccess.data,
    }
  }

  const errorResult = ClaudeResultError.safeParse(raw)
  if (errorResult.success) {
    const msg = errorResult.data.errors[0] ?? 'unknown error'
    return { kind: 'terminal', type: 'error', message: msg, data: errorResult.data }
  }

  return {
    kind: 'terminal',
    type: 'error',
    message: `Malformed result envelope: ${successResult.error.issues.map((i) => i.message).join('; ')}`,
  }
}

export function parseClaudeLine(line: string): import('../types.ts').RunnerEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return null
    throw err
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') return null

  if (obj.type === 'result') {
    return parseResultEnvelope(obj)
  }

  return {
    kind: 'info',
    type: obj.type,
    payload: obj as Readonly<Record<string, unknown>>,
  }
}

// ---------------------------------------------------------------------------
// Argv builders — extracted for cognitive complexity budget
// ---------------------------------------------------------------------------

function buildInteractiveArgv(
  ctx: RunnerContext,
  opts: { model?: string; flags?: readonly string[] },
): readonly string[] {
  return [
    'claude',
    ...(ctx.sessionId ? ['--session-id', ctx.sessionId] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.flags ?? []),
    ...ctx.extraArgs,
    '--',
    ctx.prompt,
  ]
}

function buildAutonomousArgv(
  ctx: RunnerContext,
  opts: { model?: string; maxTurns?: number; bare: boolean; flags?: readonly string[] },
): readonly string[] {
  return [
    'claude',
    ...(opts.bare ? ['--bare'] : []),
    '-p',
    ctx.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.maxTurns !== undefined ? ['--max-turns', String(opts.maxTurns)] : []),
    ...(ctx.schema ? ['--json-schema', ctx.schema.jsonSchema] : []),
    ...(opts.flags ?? []),
    ...ctx.extraArgs,
  ]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function claude(opts: ClaudeOptions = {}): Readonly<Runner> {
  const { model, maxTurns, bare = true, flags } = opts

  return defineRunner({
    name: 'claude',
    supports: { interactive: true, structuredOutput: true },

    buildCommand(ctx: RunnerContext): RunnerCommand {
      for (const flag of flags ?? []) assertFlagAllowed(flag)
      for (const flag of ctx.extraArgs) assertFlagAllowed(flag)

      const env = buildClaudeEnv(ctx.env, process.env)
      // Interactive mode note (2026-04-14): BunProcessService.spawnForeground
      // spawns the child with `stdio: 'inherit'`. `inherit` shares file
      // descriptors but does NOT allocate a PTY, so inside the Claude CLI
      // `process.stdout.isTTY === false`. Ink/chalk/supports-color then fall
      // back to a monochrome renderer — the "black-and-white" session we saw
      // in docs/solutions/interactive-mode-colors.md.
      // Forcing FORCE_COLOR=3 re-enables truecolor ANSI output via chalk even
      // without a real TTY. This is a targeted fix for colors only; a full PTY
      // passthrough (Bun.Terminal) would also restore interactive features
      // like cursor movement and resize, but costs ~30 LoC of plumbing. See
      // the solutions doc before escalating.
      if (ctx.mode === 'interactive') {
        env.FORCE_COLOR = '3'
      }
      const argv =
        ctx.mode === 'interactive'
          ? buildInteractiveArgv(ctx, { model, flags })
          : buildAutonomousArgv(ctx, { model, maxTurns, bare, flags })
      return { argv, env }
    },

    parseEvents: parseClaudeLine,

    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined
      const parsed = ClaudeResultSuccess.safeParse(finalEvent.data)
      if (!parsed.success) return undefined
      if (parsed.data.structured_output !== undefined) return parsed.data.structured_output
      return parsed.data.result
    },
  })
}
