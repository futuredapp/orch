#!/usr/bin/env bun
//
// fetch-session.ts — fetch a Claude Code or Codex CLI session transcript by ID
// and emit it as normalized JSON or readable Markdown for later analysis.
//
//   bun scripts/fetch-session.ts <session-id>
//   bun scripts/fetch-session.ts <session-id> --format markdown
//   bun scripts/fetch-session.ts <session-id> --format raw --out session.json
//   bun scripts/fetch-session.ts --list                 # list every session
//   bun scripts/fetch-session.ts --list --tool codex    # list one tool's sessions
//
// Both tools store sessions as JSONL, one record per line:
//   - Claude Code:  ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   - Codex CLI:    ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//
// The session ID is the UUID. The tool is auto-detected from where the file is
// found; pass --tool to disambiguate or to narrow --list. Partial-ID prefixes
// are accepted when they resolve to exactly one session.
//
// No dependencies beyond Bun + the standard library. This is an analysis tool,
// not part of the orch core, so it reads the home directories directly rather
// than going through ProcessService.

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

// ---------------------------------------------------------------------------
// Types — a single normalized model both formats collapse into.
// ---------------------------------------------------------------------------

export type Tool = 'claude' | 'codex'
type Role = 'user' | 'assistant' | 'system' | 'reasoning' | 'tool'

interface ToolCall {
  readonly id?: string
  readonly name: string
  readonly input: unknown
}

interface ToolResult {
  readonly callId?: string
  readonly output: string
  readonly isError?: boolean
}

interface NormalMessage {
  readonly role: Role
  readonly timestamp?: string
  /** Plain text (user/assistant text, system text, reasoning summary). */
  readonly text?: string
  readonly toolCalls?: readonly ToolCall[]
  readonly toolResult?: ToolResult
  /** Injected/system-generated turn — usually skip for "real dialogue". */
  readonly meta?: boolean
}

export interface NormalSession {
  readonly id: string
  readonly tool: Tool
  readonly file: string
  readonly cwd?: string
  readonly gitBranch?: string
  readonly cliVersion?: string
  readonly model?: string
  readonly startedAt?: string
  readonly title?: string
  readonly messageCount: number
  readonly messages: readonly NormalMessage[]
}

export interface Located {
  readonly tool: Tool
  readonly id: string
  readonly file: string
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

const CLAUDE_ROOT = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  'projects',
)
const CODEX_ROOT = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')

// A v4/v7 UUID, the shape both tools use for session IDs.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Every Claude session file: ~/.claude/projects/<dir>/<uuid>.jsonl. */
async function listClaude(): Promise<Located[]> {
  const out: Located[] = []
  const glob = new Bun.Glob('*/*.jsonl')
  for await (const rel of glob.scan({ cwd: CLAUDE_ROOT })) {
    const name = basename(rel, '.jsonl')
    // Session files are named by UUID; skip subagent transcripts (agent-*.jsonl).
    if (!UUID_RE.test(name) || name.startsWith('agent-')) continue
    out.push({ tool: 'claude', id: name, file: join(CLAUDE_ROOT, rel) })
  }
  return out
}

/** Every Codex rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. */
async function listCodex(): Promise<Located[]> {
  const out: Located[] = []
  const glob = new Bun.Glob('**/rollout-*.jsonl')
  for await (const rel of glob.scan({ cwd: CODEX_ROOT })) {
    const m = basename(rel).match(UUID_RE)
    if (!m) continue
    out.push({ tool: 'codex', id: m[0], file: join(CODEX_ROOT, rel) })
  }
  return out
}

export async function listAll(tool: Tool | 'auto'): Promise<Located[]> {
  const groups = await Promise.all([
    tool === 'codex' ? Promise.resolve([]) : safe(listClaude),
    tool === 'claude' ? Promise.resolve([]) : safe(listCodex),
  ])
  return groups.flat()
}

async function safe(fn: () => Promise<Located[]>): Promise<Located[]> {
  try {
    return await fn()
  } catch {
    return [] // root may not exist on a machine that lacks one of the CLIs
  }
}

/** Resolve a (possibly partial) ID to exactly one session, or throw. */
export async function locate(id: string, tool: Tool | 'auto'): Promise<Located> {
  const all = await listAll(tool)
  const lower = id.toLowerCase()
  const exact = all.filter((s) => s.id.toLowerCase() === lower)
  const matches = exact.length > 0 ? exact : all.filter((s) => s.id.toLowerCase().startsWith(lower))

  if (matches.length === 0) {
    throw new Error(`No ${tool === 'auto' ? '' : tool + ' '}session found for ID "${id}".`)
  }
  if (matches.length > 1) {
    const lines = matches.slice(0, 10).map((m) => `  ${m.tool}  ${m.id}`)
    throw new Error(
      `Ambiguous ID "${id}" — ${matches.length} sessions match:\n${lines.join('\n')}` +
        (matches.length > 10 ? '\n  …' : ''),
    )
  }
  return matches[0]!
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export async function loadLines(file: string): Promise<unknown[]> {
  const raw = await Bun.file(file).text()
  const records: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // Tolerate a torn final line or a non-JSON line; skip it.
    }
  }
  return records
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// --- Claude --------------------------------------------------------------

export function normalizeClaude(id: string, file: string, records: unknown[]): NormalSession {
  const messages: NormalMessage[] = []
  let cwd: string | undefined
  let gitBranch: string | undefined
  let cliVersion: string | undefined
  let model: string | undefined
  let startedAt: string | undefined
  let title: string | undefined

  for (const rec of records) {
    const o = asObj(rec)
    const type = asStr(o.type)
    cwd ??= asStr(o.cwd)
    gitBranch ??= asStr(o.gitBranch)
    cliVersion ??= asStr(o.version)
    startedAt ??= asStr(o.timestamp)

    if (type === 'summary') title ??= asStr(o.summary)
    if (type === 'custom-title') title ??= asStr(o.customTitle)
    if (type !== 'user' && type !== 'assistant') continue

    const msg = asObj(o.message)
    const ts = asStr(o.timestamp)
    const meta = o.isMeta === true || o.isCompactSummary === true
    const content = msg.content

    if (type === 'user') {
      if (typeof content === 'string') {
        messages.push({ role: 'user', timestamp: ts, text: content, meta: meta || undefined })
        continue
      }
      for (const block of Array.isArray(content) ? content : []) {
        const b = asObj(block)
        if (b.type === 'tool_result') {
          messages.push({
            role: 'tool',
            timestamp: ts,
            toolResult: {
              callId: asStr(b.tool_use_id),
              output: stringifyContent(b.content),
              isError: b.is_error === true || undefined,
            },
          })
        } else if (b.type === 'text') {
          messages.push({ role: 'user', timestamp: ts, text: asStr(b.text), meta: meta || undefined })
        }
      }
      continue
    }

    // assistant
    model ??= asStr(msg.model)
    const calls: ToolCall[] = []
    for (const block of Array.isArray(content) ? content : []) {
      const b = asObj(block)
      switch (b.type) {
        case 'text':
          messages.push({ role: 'assistant', timestamp: ts, text: asStr(b.text) })
          break
        case 'thinking':
          messages.push({ role: 'reasoning', timestamp: ts, text: asStr(b.thinking) })
          break
        case 'tool_use':
          calls.push({ id: asStr(b.id), name: asStr(b.name) ?? '?', input: b.input })
          break
      }
    }
    if (calls.length > 0) {
      messages.push({ role: 'assistant', timestamp: ts, toolCalls: calls })
    }
  }

  return {
    id,
    tool: 'claude',
    file,
    cwd,
    gitBranch,
    cliVersion,
    model,
    startedAt,
    title,
    messageCount: messages.length,
    messages,
  }
}

// --- Codex ---------------------------------------------------------------

export function normalizeCodex(id: string, file: string, records: unknown[]): NormalSession {
  const messages: NormalMessage[] = []
  let cwd: string | undefined
  let gitBranch: string | undefined
  let cliVersion: string | undefined
  let model: string | undefined
  let startedAt: string | undefined

  for (const rec of records) {
    const o = asObj(rec)
    const type = asStr(o.type)
    const ts = asStr(o.timestamp)
    const payload = asObj(o.payload)

    if (type === 'session_meta') {
      cwd ??= asStr(payload.cwd)
      cliVersion ??= asStr(payload.cli_version)
      startedAt ??= asStr(payload.timestamp) ?? ts
      gitBranch ??= asStr(asObj(payload.git).branch)
      continue
    }
    if (type === 'turn_context') {
      model ??= asStr(payload.model)
      continue
    }
    // event_msg records (user_message / agent_message) duplicate the
    // response_item messages, so we build the transcript from response_item only.
    if (type !== 'response_item') continue

    const inner = asStr(payload.type)
    switch (inner) {
      case 'message': {
        const role = asStr(payload.role)
        const text = codexText(payload.content)
        const isAssistant = role === 'assistant'
        messages.push({
          role: isAssistant ? 'assistant' : role === 'system' || role === 'developer' ? 'system' : 'user',
          timestamp: ts,
          text,
          meta: role === 'developer' || role === 'system' ? true : undefined,
        })
        break
      }
      case 'reasoning': {
        const text = codexText(payload.summary) || codexText(payload.content)
        if (text) messages.push({ role: 'reasoning', timestamp: ts, text })
        break
      }
      case 'function_call':
      case 'local_shell_call':
      case 'custom_tool_call': {
        messages.push({
          role: 'assistant',
          timestamp: ts,
          toolCalls: [
            {
              id: asStr(payload.call_id),
              name: asStr(payload.name) ?? inner,
              input: parseMaybeJson(payload.arguments ?? payload.input ?? payload.action),
            },
          ],
        })
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        messages.push({
          role: 'tool',
          timestamp: ts,
          toolResult: { callId: asStr(payload.call_id), output: stringifyContent(payload.output) },
        })
        break
      }
    }
  }

  return {
    id,
    tool: 'codex',
    file,
    cwd,
    gitBranch,
    cliVersion,
    model,
    startedAt,
    messageCount: messages.length,
    messages,
  }
}

/** Codex content arrays are [{type:'input_text'|'output_text'|..., text}]. */
function codexText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .map((b) => asStr(asObj(b).text))
    .filter((t): t is string => typeof t === 'string')
  return parts.length > 0 ? parts.join('\n') : undefined
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Tool result/output content can be a string, an object, or a block array. */
function stringifyContent(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v.map((b) => asStr(asObj(b).text) ?? asStr(asObj(b).content) ?? JSON.stringify(b)).join('\n')
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return asStr(o.content) ?? asStr(o.output) ?? asStr(o.stdout) ?? JSON.stringify(v)
  }
  return v == null ? '' : String(v)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Locate, read, and normalize a session by ID in one call — the reusable entry
 * point for other scripts (e.g. fetch-workflow.ts). Returns null when the
 * session can't be found or resolves ambiguously, so callers can skip gaps.
 */
export async function fetchSession(
  id: string,
  tool: Tool | 'auto' = 'auto',
): Promise<NormalSession | null> {
  let found: Located
  try {
    found = await locate(id, tool)
  } catch {
    return null
  }
  const records = await loadLines(found.file)
  return found.tool === 'claude'
    ? normalizeClaude(found.id, found.file, records)
    : normalizeCodex(found.id, found.file, records)
}

export function toMarkdown(s: NormalSession): string {
  const out: string[] = []
  out.push(`# ${s.title ?? `${s.tool} session`}`)
  out.push('')
  out.push(`- **Tool:** ${s.tool}`)
  out.push(`- **Session ID:** \`${s.id}\``)
  if (s.startedAt) out.push(`- **Started:** ${s.startedAt}`)
  if (s.cwd) out.push(`- **Working dir:** \`${s.cwd}\``)
  if (s.gitBranch) out.push(`- **Git branch:** \`${s.gitBranch}\``)
  if (s.model) out.push(`- **Model:** ${s.model}`)
  if (s.cliVersion) out.push(`- **CLI version:** ${s.cliVersion}`)
  out.push(`- **Messages:** ${s.messageCount}`)
  out.push(`- **File:** \`${s.file}\``)
  out.push('')
  out.push('---')
  out.push('')

  for (const m of s.messages) {
    const tag = m.meta ? ` _(meta)_` : ''
    if (m.role === 'tool') {
      out.push(`### 🔧 tool result${m.toolResult?.isError ? ' (error)' : ''}`)
      out.push('')
      out.push('```')
      out.push(truncate(m.toolResult?.output ?? '', 4000))
      out.push('```')
    } else if (m.toolCalls) {
      for (const c of m.toolCalls) {
        out.push(`### 🤖 assistant → \`${c.name}\``)
        out.push('')
        out.push('```json')
        out.push(truncate(JSON.stringify(c.input, null, 2), 4000))
        out.push('```')
      }
    } else {
      const icon =
        m.role === 'user' ? '🧑 user' : m.role === 'assistant' ? '🤖 assistant' : m.role === 'reasoning' ? '💭 reasoning' : '⚙️ system'
      out.push(`### ${icon}${tag}`)
      out.push('')
      out.push(m.text ?? '')
    }
    out.push('')
  }
  return out.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `fetch-session — export a Claude Code / Codex CLI session by ID

Usage:
  bun scripts/fetch-session.ts <session-id> [options]
  bun scripts/fetch-session.ts --list [--tool claude|codex]

Options:
  --format <fmt>   json (default) | markdown | raw
  --tool <tool>    claude | codex | auto (default)
  --out <file>     write to a file instead of stdout
  --list           list available sessions (most recent first) and exit
  -h, --help       show this help

Examples:
  bun scripts/fetch-session.ts adbd5b59
  bun scripts/fetch-session.ts 019eb2fe-828c-77f2-a338-c000c2363b3e --format markdown
  bun scripts/fetch-session.ts adbd5b59 --format json --out session.json`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      format: { type: 'string', default: 'json' },
      tool: { type: 'string', default: 'auto' },
      out: { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    console.log(HELP)
    return
  }

  const tool = values.tool as Tool | 'auto'
  if (tool !== 'auto' && tool !== 'claude' && tool !== 'codex') {
    throw new Error(`--tool must be claude, codex, or auto (got "${tool}")`)
  }

  if (values.list) {
    const all = await listAll(tool)
    if (all.length === 0) {
      console.error('No sessions found.')
      process.exitCode = 1
      return
    }
    // Most-recently-modified first.
    const withMtime = await Promise.all(
      all.map(async (s) => ({ ...s, mtime: (await Bun.file(s.file).stat()).mtimeMs })),
    )
    withMtime.sort((a, b) => b.mtime - a.mtime)
    for (const s of withMtime) {
      console.log(`${s.tool.padEnd(6)}  ${s.id}  ${s.file}`)
    }
    return
  }

  const id = positionals[0]
  if (!id) {
    console.error(HELP)
    process.exitCode = 1
    return
  }

  const format = values.format as string
  if (format !== 'json' && format !== 'markdown' && format !== 'raw') {
    throw new Error(`--format must be json, markdown, or raw (got "${format}")`)
  }

  const found = await locate(id, tool)
  const records = await loadLines(found.file)

  let output: string
  if (format === 'raw') {
    output = JSON.stringify(records, null, 2)
  } else {
    const session =
      found.tool === 'claude'
        ? normalizeClaude(found.id, found.file, records)
        : normalizeCodex(found.id, found.file, records)
    output = format === 'markdown' ? toMarkdown(session) : JSON.stringify(session, null, 2)
  }

  if (values.out) {
    await Bun.write(values.out, output)
    console.error(`Wrote ${output.length} bytes → ${values.out}`)
  } else {
    console.log(output)
  }
}

// Only run the CLI when executed directly; importing this module (e.g. from
// fetch-workflow.ts) must not trigger argument parsing or output.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
