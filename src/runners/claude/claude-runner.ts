// **File size.** This file exceeds the project's 300-LOC warning cap after the
// auto-stop hook-injection block (parser + argv builders + two runner methods +
// the prepareAutoStop helpers). The pieces are cohesive — all Claude-CLI
// adapter concerns — and splitting for size alone would scatter the adapter.
// Revisit if a second large capability lands here.

import { z } from 'zod'
import { BunFsService, type FsService, mergeEnv } from '../../services/index.ts'
import { type Path, path } from '../../services/types.ts'
import type {
  AutoStopPreparation,
  Runner,
  RunnerCommand,
  RunnerContext,
  TerminalEvent,
} from '../types.ts'
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
// Auto-stop hook injection (R3–R6, R9)
// ---------------------------------------------------------------------------
//
// The injected hook is a signal *only*: it pings orch over the tmux wait-for
// channel when Claude finishes (or fails to finish) a turn. orch — which owns
// the pane — performs the actual termination. The command references the
// env-var NAMES the tmux host injects at spawn; prepareAutoStop never needs
// the socket/channel values. We write `.claude/settings.local.json` in cwd
// rather than passing `--settings` (which is on the denylist), and we MERGE
// into any existing hooks so a user's own settings are never clobbered.

/** Signal-only one-liner. No termination verb, no stdout side effect — just
 *  unblocks orch's `wait-for` on the per-run stop channel. The socket selector
 *  is `-L <name>` (not `-S <path>`): orch's server runs on a named socket
 *  (`tmux -L orch-<runId>`), and a fresh `tmux` client from the hook would
 *  otherwise connect to the default server and never reach orch's `wait-for`.
 *  The `-S` after `wait-for` is the unrelated signal-channel flag. */
const AUTO_STOP_HOOK_COMMAND = 'tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"' as const

/** Events that mean "the turn is over" — a normal stop and a stop-hook failure. */
const AUTO_STOP_HOOK_EVENTS = ['Stop', 'StopFailure'] as const

interface ClaudeHookEntry {
  readonly hooks: ReadonlyArray<{ readonly type: 'command'; readonly command: string }>
}

/** Append the signal-only hook to each stop event, preserving any hooks the
 *  user already registered for that event (merge, never replace). */
function mergeStopHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const priorHooks =
    typeof existing.hooks === 'object' && existing.hooks !== null
      ? (existing.hooks as Record<string, unknown>)
      : {}
  const injected: ClaudeHookEntry = {
    hooks: [{ type: 'command', command: AUTO_STOP_HOOK_COMMAND }],
  }
  const nextHooks: Record<string, unknown> = { ...priorHooks }
  for (const event of AUTO_STOP_HOOK_EVENTS) {
    const current = Array.isArray(priorHooks[event]) ? (priorHooks[event] as unknown[]) : []
    nextHooks[event] = [...current, injected]
  }
  return { ...existing, hooks: nextHooks }
}

/** Read + parse the existing settings file, tolerating malformed JSON (treated
 *  as "no usable prior settings" so injection still succeeds). Returns the
 *  original bytes for the cleanup inverse, or `undefined` if absent. */
async function readExistingSettings(
  fs: FsService,
  settingsPath: Path,
): Promise<{ readonly original: string | undefined; readonly parsed: Record<string, unknown> }> {
  if (!(await fs.exists(settingsPath))) return { original: undefined, parsed: {} }
  const original = await fs.readFile(settingsPath)
  try {
    const parsed = JSON.parse(original) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { original, parsed: parsed as Record<string, unknown> }
    }
  } catch {
    // Malformed prior file — keep the original bytes for restore, but merge
    // into an empty base so we still register the hook.
  }
  return { original, parsed: {} }
}

async function prepareClaudeAutoStop(
  fs: FsService,
  cwd: RunnerContext['cwd'],
): Promise<AutoStopPreparation> {
  const claudeDir = path(`${cwd}/.claude`)
  const settingsPath = path(`${cwd}/.claude/settings.local.json`)
  await fs.mkdir(claudeDir, { recursive: true })

  const { original, parsed } = await readExistingSettings(fs, settingsPath)
  const merged = mergeStopHooks(parsed)
  await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)

  const cleanup = async (): Promise<void> => {
    // True inverse: restore the user's original file, or remove ours if none
    // existed. Only ever touches the per-run cwd file — never `~/.claude`.
    if (original === undefined) await fs.remove(settingsPath)
    else await fs.writeFile(settingsPath, original)
  }
  return { env: {}, cleanup }
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

  // Surface the system-init line as a `session-started` info event so the
  // workflow executor (and downstream consumers) can capture `sessionId`
  // without grovelling for `subtype === 'init'` everywhere. The original
  // payload is preserved verbatim under `payload` — format-event.ts still
  // renders it via the same formatSystemInit path.
  if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
    return {
      kind: 'info',
      type: 'session-started',
      payload: { sessionId: obj.session_id, ...obj },
    }
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

export function claude(
  opts: ClaudeOptions = {},
  deps: { readonly fs?: FsService } = {},
): Readonly<Runner> {
  const { model, maxTurns, bare = true, flags } = opts
  // `fs` is only needed by `prepareAutoStop` (auto-stop opt-in). Defaulted so
  // the public `claude({...})` call form stays intact; tests inject a fake.
  const fs = deps.fs ?? new BunFsService()

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

    resumeCommand(ctx: RunnerContext, sessionId: string): RunnerCommand {
      // Resume always launches Claude in interactive mode — the user pressed
      // Enter on a finished interactive step and wants to continue the
      // conversation, not re-run a one-shot autonomous job. `--bare` would
      // strip the TUI; we explicitly omit it.
      const argv = [
        'claude',
        '--resume',
        sessionId,
        ...(model ? ['--model', model] : []),
        ...(flags ?? []),
        ...ctx.extraArgs,
      ]
      const env = mergeEnv(process.env, { FORCE_COLOR: '3' }, ctx.env)
      return { argv, env }
    },

    prepareAutoStop(ctx: RunnerContext): Promise<AutoStopPreparation> {
      // Write the merge-safe `.claude/settings.local.json` before launch (the
      // host order guarantees this happens before the pane spawns). Claude
      // reads it from cwd, so no env additions are needed.
      return prepareClaudeAutoStop(fs, ctx.cwd)
    },
  })
}
