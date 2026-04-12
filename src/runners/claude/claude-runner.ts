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
// Factory
// ---------------------------------------------------------------------------

export function claude(opts: ClaudeOptions = {}): Readonly<Runner> {
  const { model, maxTurns, bare = true, flags } = opts

  return defineRunner({
    name: 'claude',
    supports: { interactive: false, structuredOutput: true },

    buildCommand(ctx: RunnerContext): RunnerCommand {
      for (const flag of flags ?? []) assertFlagAllowed(flag)
      for (const flag of ctx.extraArgs) assertFlagAllowed(flag)

      const argv = [
        'claude',
        ...(bare ? ['--bare'] : []),
        '-p',
        ctx.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        ...(model ? ['--model', model] : []),
        ...(maxTurns !== undefined ? ['--max-turns', String(maxTurns)] : []),
        ...(ctx.schema ? ['--json-schema', ctx.schema.jsonSchema] : []),
        ...(flags ?? []),
        ...ctx.extraArgs,
      ]
      return { argv, env: buildClaudeEnv(ctx.env, process.env) }
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
