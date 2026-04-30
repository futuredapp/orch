import { z } from 'zod'
import type { FsService } from '../../services/fs/fs-service.ts'
import { mergeEnv } from '../../services/index.ts'
import type { ProcessService } from '../../services/process/process-service.ts'
import { path } from '../../services/types.ts'
import type { RunnerCommand, RunnerContext, RunnerEvent, TerminalEvent } from '../types.ts'
import { defineRunner } from '../types.ts'

// Section order: schemas, types, denylist, parser, version preflight, factory.

// ---------------------------------------------------------------------------
// Zod schemas — terminal events only (forward-compatible with new event types)
// ---------------------------------------------------------------------------

const CodexTurnCompleted = z
  .object({
    type: z.literal('turn.completed'),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const CodexTurnFailed = z
  .object({
    type: z.literal('turn.failed'),
    error: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface CodexOptions {
  readonly model?: string
  readonly sandbox?: 'full-auto' | 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly flags?: readonly string[]
}

// ---------------------------------------------------------------------------
// Flag denylist
// ---------------------------------------------------------------------------

const CODEX_FLAG_DENYLIST = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--config',
  '--sandbox',
  '-c',
  '--approval-mode',
] as const

function assertFlagAllowed(flag: string): void {
  for (const deny of CODEX_FLAG_DENYLIST) {
    if (flag === deny || flag.startsWith(`${deny}=`)) {
      throw new Error(`codex(): flag "${flag}" is on the denylist`)
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone NDJSON parser — exported for direct unit testing
// ---------------------------------------------------------------------------

function parseTerminalEvent(obj: Record<string, unknown>): RunnerEvent | null {
  if (obj.type === 'turn.completed') {
    const result = CodexTurnCompleted.safeParse(obj)
    return { kind: 'terminal', type: 'turn-complete', data: result.success ? result.data : obj }
  }

  if (obj.type === 'turn.failed') {
    const result = CodexTurnFailed.safeParse(obj)
    const message = result.success ? result.data.error.message : 'unknown error'
    return { kind: 'terminal', type: 'error', message, data: obj }
  }

  if (obj.type === 'error') {
    const message = typeof obj.message === 'string' ? obj.message : 'unknown error'
    return { kind: 'terminal', type: 'error', message, data: obj }
  }

  return null
}

export function parseCodexLine(line: string): RunnerEvent | null {
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

  const terminal = parseTerminalEvent(obj)
  if (terminal) return terminal

  return {
    kind: 'info',
    type: obj.type,
    payload: obj as Readonly<Record<string, unknown>>,
  }
}

// ---------------------------------------------------------------------------
// Version preflight
// ---------------------------------------------------------------------------

const MIN_CODEX_VERSION = '0.118.0'

export class CodexVersionError extends Error {
  constructor(found: string, required: string) {
    super(
      `codex CLI version ${found} is too old. ` +
        `orch requires >= ${required}. ` +
        `Upgrade with: npm i -g @openai/codex`,
    )
    this.name = 'CodexVersionError'
  }
}

function parseVersionTriple(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

function versionSatisfies(
  found: [number, number, number],
  required: [number, number, number],
): boolean {
  if (found[0] !== required[0]) return found[0] > required[0]
  if (found[1] !== required[1]) return found[1] > required[1]
  return found[2] >= required[2]
}

async function checkCodexVersion(ps: ProcessService): Promise<void> {
  const which = Bun.which('codex')
  if (!which) {
    throw new CodexVersionError('not found', MIN_CODEX_VERSION)
  }

  const handle = ps.spawn({
    argv: ['codex', '--version'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    cwd: path('/tmp'),
  })

  let firstLine = ''
  for await (const line of handle.stdout) {
    if (!firstLine) firstLine = line
  }

  await handle.wait()
  const found = parseVersionTriple(firstLine)
  if (!found) {
    throw new CodexVersionError(firstLine || 'unknown', MIN_CODEX_VERSION)
  }

  const required = parseVersionTriple(MIN_CODEX_VERSION)
  if (required && !versionSatisfies(found, required)) {
    throw new CodexVersionError(`${found[0]}.${found[1]}.${found[2]}`, MIN_CODEX_VERSION)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function codex(
  opts: CodexOptions,
  deps: { readonly fs: FsService; readonly ps: ProcessService },
): Readonly<
  import('../types.ts').Runner & {
    buildCommand(ctx: RunnerContext): Promise<RunnerCommand>
  }
> {
  const { model, sandbox = 'full-auto', flags } = opts

  let versionChecked = false
  let lastAgentMessage: string | undefined

  return defineRunner({
    name: 'codex',
    supports: { interactive: false, structuredOutput: true },
    defaultView: { kind: 'transcript', pane: 'right' },

    async buildCommand(ctx: RunnerContext): Promise<RunnerCommand> {
      lastAgentMessage = undefined // Reset per invocation

      for (const flag of flags ?? []) assertFlagAllowed(flag)
      for (const flag of ctx.extraArgs) assertFlagAllowed(flag)

      if (!versionChecked) {
        await checkCodexVersion(deps.ps)
        versionChecked = true
      }

      const argv: string[] = ['codex', 'exec', '--json', '--skip-git-repo-check', '--ephemeral']

      if (sandbox === 'full-auto') {
        argv.push('--full-auto')
      } else {
        argv.push('--sandbox', sandbox)
      }

      if (model) {
        argv.push('-m', model)
      }

      if (ctx.schema) {
        const dir = await deps.fs.tempDir('codex-schema')
        const filePath = path(`${dir}/schema.json`)
        await deps.fs.writeFile(filePath, ctx.schema.jsonSchema)
        argv.push('--output-schema', filePath)
      }

      argv.push(...(flags ?? []))
      argv.push(...ctx.extraArgs)
      argv.push('--', ctx.prompt)

      // Env: passthrough by default (see mergeEnv contract). Codex has no
      // mode-specific extras today, so the middle layer is `{}`. `ctx.env`
      // wins last on conflict — the workflow YAML is the override surface.
      return { argv, env: mergeEnv(process.env, {}, ctx.env) }
    },

    parseEvents(line: string): RunnerEvent | null {
      const evt = parseCodexLine(line)

      // Accumulate agent_message text for structured output extraction
      if (evt !== null && evt.kind === 'info' && evt.type === 'item.completed') {
        const item = (evt.payload as Record<string, unknown> | undefined)?.item
        if (typeof item === 'object' && item !== null) {
          const typedItem = item as Record<string, unknown>
          if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
            lastAgentMessage = typedItem.text
          }
        }
      }

      // Stash accumulated text into terminal event data
      if (evt !== null && evt.kind === 'terminal' && evt.type === 'turn-complete') {
        return {
          kind: 'terminal',
          type: 'turn-complete',
          data: { ...(evt.data as Record<string, unknown>), _accumulatedText: lastAgentMessage },
        }
      }

      return evt
    },

    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined

      const data = finalEvent.data as Record<string, unknown> | undefined
      const text = data?._accumulatedText
      if (typeof text !== 'string') return undefined
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    },

    // Phase A placeholder. Codex's formatter lands in Phase B; until then
    // every Codex event is suppressed from the readable transcript. The JSON
    // path and on-disk transcript.ndjson are unaffected.
    toTranscriptLines: () => [],
  })
}
