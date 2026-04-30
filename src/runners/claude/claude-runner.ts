import { z } from 'zod'
import { mergeEnv } from '../../services/index.ts'
import type { Runner, RunnerCommand, RunnerContext, TerminalEvent } from '../types.ts'
import { defineRunner } from '../types.ts'
import { toClaudeTranscriptLines } from './format-event.ts'

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
// Flag denylist
// ---------------------------------------------------------------------------
// Flags that would let a caller inject arbitrary config or MCP servers —
// genuine code-execution vectors. Denied whether they appear in `flags` or
// `ctx.extraArgs`. Note: `--dangerously-skip-permissions` used to live here
// but was removed by explicit product decision so sandboxed workflows can
// opt into unattended runs. Permission bypass is surfaced to the caller as
// a regular flag, not a secret denylist.
const CLAUDE_FLAG_DENYLIST = ['--settings', '--mcp-config'] as const

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
    defaultView: { kind: 'transcript', pane: 'right' },

    buildCommand(ctx: RunnerContext): RunnerCommand {
      for (const flag of flags ?? []) assertFlagAllowed(flag)
      for (const flag of ctx.extraArgs) assertFlagAllowed(flag)

      // Env: passthrough by default — every key from `process.env` reaches the
      // child. `extras` is a runner/mode-specific override slot; for Claude in
      // interactive mode we add `FORCE_COLOR=3` so Ink/chalk render truecolor
      // ANSI under the inherited (non-PTY) stdio that BunProcessService uses
      // (see docs/solutions/interactive-mode-colors.md). `ctx.env` always wins
      // last — workflow authors can disable extras by setting `FORCE_COLOR=0`.
      const extras: Readonly<Record<string, string>> =
        ctx.mode === 'interactive' ? { FORCE_COLOR: '3' } : {}
      const env = mergeEnv(process.env, extras, ctx.env)
      const argv =
        ctx.mode === 'interactive'
          ? buildInteractiveArgv(ctx, { model, flags })
          : buildAutonomousArgv(ctx, { model, maxTurns, bare, flags })
      return { argv, env }
    },

    parseEvents: parseClaudeLine,

    toTranscriptLines: toClaudeTranscriptLines,

    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined
      const parsed = ClaudeResultSuccess.safeParse(finalEvent.data)
      if (!parsed.success) return undefined
      if (parsed.data.structured_output !== undefined) return parsed.data.structured_output
      return parsed.data.result
    },
  })
}
