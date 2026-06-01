// ---------------------------------------------------------------------------
// format-event — Claude RunnerEvent → readonly TranscriptLine[]
// ---------------------------------------------------------------------------
//
// The Claude CLI's NDJSON nests its interesting types inside
// `payload.message.content[<i>]`: `thinking`, `tool_use`, `text` for the
// assistant role; `tool_result` (sometimes with `is_error: true`) for user.
// This module flattens those into one or more TranscriptLines per event,
// already truncated and stripped of structure the host doesn't need.
//
// All formatting is pure: no I/O, no module-level side effects, no shared
// mutable state. Helpers stay private to this file (per plan: promote to
// shared the day a second consumer needs them).
//
// Hosts handle ANSI, glyphs, and the `[<step>] ` prefix — categories carry
// the semantic intent, never the visual treatment.

import type { InfoEvent, RunnerEvent, TerminalEvent, TranscriptLine } from '../types.ts'

// Truncation limits — see plan's truncation table.
const MAX_BASH_COMMAND = 120
const MAX_FILE_PATH = 60
const MAX_GENERIC_INPUT = 80
const MAX_TOOL_RESULT_LINE = 80
const MAX_ERROR_TEXT = 200
const MAX_ASSISTANT_TEXT = 4000

export function toClaudeTranscriptLines(event: RunnerEvent): readonly TranscriptLine[] {
  if (event.kind === 'terminal') return formatTerminal(event)
  return formatInfo(event)
}

function formatInfo(event: InfoEvent): readonly TranscriptLine[] {
  switch (event.type) {
    case 'session-started':
      // `session-started` is the synthesized type the runner emits for the
      // system-init line (see parseClaudeLine), so it always carries the
      // init payload (model/tools/mcp_servers).
      return formatSystemInit(event)
    case 'system':
      // Every non-init `type:"system"` event keeps `type:"system"` after the
      // parser. Only `subtype:"init"` should render the init summary; the rest
      // (task_progress, thinking_tokens, lifecycle pings from background
      // workflows) must NOT be stamped out as bogus `model=?` init lines.
      return formatSystemEvent(event)
    case 'assistant':
      return formatAssistantMessage(event)
    case 'user':
      return formatUserMessage(event)
    case 'rate_limit_event':
      return []
    default:
      return [{ kind: 'line', category: 'system', body: `· ${event.type}` }]
  }
}

// Subtypes that arrive at high frequency and carry no transcript value —
// dropped outright (like rate_limit_event) to keep the pane readable. The
// 50 task_progress + 10 thinking_tokens pings from a background sub-workflow
// were what flooded the transcript with `model=?` lines.
const SUPPRESSED_SYSTEM_SUBTYPES = new Set(['task_progress', 'thinking_tokens'])

function formatSystemEvent(event: InfoEvent): readonly TranscriptLine[] {
  const payload = event.payload ?? {}
  const subtype = readString(payload, 'subtype')
  if (subtype === 'init') return formatSystemInit(event)
  if (subtype !== undefined && SUPPRESSED_SYSTEM_SUBTYPES.has(subtype)) return []
  return [{ kind: 'line', category: 'system', body: `· ${subtype ?? 'system'}` }]
}

function formatSystemInit(event: InfoEvent): readonly TranscriptLine[] {
  const payload = event.payload ?? {}
  const model = readString(payload, 'model') ?? '?'
  const tools = Array.isArray(payload.tools) ? payload.tools.length : 0
  const mcp = Array.isArray(payload.mcp_servers) ? payload.mcp_servers.length : 0
  return [
    {
      kind: 'line',
      category: 'system',
      body: `system: model=${model}, ${tools} tools, ${mcp} mcp servers`,
    },
  ]
}

function formatAssistantMessage(event: InfoEvent): readonly TranscriptLine[] {
  const blocks = readContentBlocks(event)
  if (blocks.length === 0) return []
  const lines: TranscriptLine[] = []
  for (const block of blocks) {
    const line = formatAssistantBlock(block)
    if (line !== null) lines.push(line)
  }
  return lines
}

function formatAssistantBlock(block: Readonly<Record<string, unknown>>): TranscriptLine | null {
  const type = readString(block, 'type')
  if (type === 'thinking') {
    return { kind: 'line', category: 'thinking', label: 'thinking', body: '' }
  }
  if (type === 'tool_use') {
    return formatToolUse(block)
  }
  if (type === 'text') {
    const text = readString(block, 'text') ?? ''
    if (text.length === 0) return null
    return {
      kind: 'line',
      category: 'assistant',
      label: 'assistant>',
      body: truncate(text, MAX_ASSISTANT_TEXT),
    }
  }
  return { kind: 'line', category: 'system', body: `· ${type ?? 'unknown'}` }
}

function formatUserMessage(event: InfoEvent): readonly TranscriptLine[] {
  const blocks = readContentBlocks(event)
  if (blocks.length === 0) return []
  const lines: TranscriptLine[] = []
  for (const block of blocks) {
    const type = readString(block, 'type')
    if (type !== 'tool_result') continue
    lines.push(formatToolResult(block))
  }
  return lines
}

function formatToolUse(block: Readonly<Record<string, unknown>>): TranscriptLine {
  const name = readString(block, 'name') ?? 'tool'
  const input = readObject(block, 'input')
  return { kind: 'line', category: 'tool-call', label: name, body: toolUseBody(name, input) }
}

function toolUseBody(name: string, input: Readonly<Record<string, unknown>> | undefined): string {
  if (input === undefined) return ''
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const filePath = readString(input, 'file_path')
    if (filePath === undefined) return ''
    return `(${middleEllipsis(filePath, MAX_FILE_PATH)})`
  }
  if (name === 'Glob') {
    const pattern = readString(input, 'pattern') ?? ''
    return `pattern: ${truncate(pattern, MAX_GENERIC_INPUT)}`
  }
  if (name === 'Bash') {
    const command = readString(input, 'command') ?? ''
    return truncate(firstLine(command), MAX_BASH_COMMAND)
  }
  if (name === 'TodoWrite') {
    const todos = input.todos
    const count = Array.isArray(todos) ? todos.length : 0
    return `<${count} todos>`
  }
  return truncate(safeJson(input), MAX_GENERIC_INPUT)
}

function formatToolResult(block: Readonly<Record<string, unknown>>): TranscriptLine {
  const isError = block.is_error === true
  const content = block.content
  const raw = typeof content === 'string' ? content : flattenResultContent(content)
  if (isError) {
    return { kind: 'line', category: 'tool-error', body: truncate(raw, MAX_ERROR_TEXT) }
  }
  return {
    kind: 'line',
    category: 'tool-result',
    body: truncate(firstNonEmptyLine(raw), MAX_TOOL_RESULT_LINE),
  }
}

function flattenResultContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const piece of content) {
    if (piece === null || typeof piece !== 'object') continue
    const text = readString(piece as Readonly<Record<string, unknown>>, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

function formatTerminal(event: TerminalEvent): readonly TranscriptLine[] {
  if (event.type === 'error') {
    return [{ kind: 'block', heading: 'failed', rows: [['message', event.message]] }]
  }
  return [formatTurnComplete(event)]
}

function formatTurnComplete(event: TerminalEvent): TranscriptLine {
  const data = (event.data ?? {}) as Readonly<Record<string, unknown>>
  const rows: Array<readonly [string, string]> = []

  const result = readString(data, 'result')
  if (result !== undefined)
    rows.push(['result', truncate(firstNonEmptyLine(result), MAX_TOOL_RESULT_LINE)])

  const durationMs = typeof data.duration_ms === 'number' ? data.duration_ms : undefined
  if (durationMs !== undefined) rows.push(['duration', formatDuration(durationMs)])

  const turns = typeof data.num_turns === 'number' ? data.num_turns : undefined
  if (turns !== undefined) rows.push(['turns', String(turns)])

  const cost = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined
  if (cost !== undefined) rows.push(['cost', `$${cost.toFixed(4)}`])

  const tokens = formatTokens(readObject(data, 'usage'))
  if (tokens !== undefined) rows.push(['tokens', tokens])

  const denials = data.permission_denials
  if (Array.isArray(denials)) rows.push(['permissions', `${denials.length} denials`])

  const session = readString(data, 'session_id')
  if (session !== undefined) rows.push(['session', session])

  return { kind: 'block', heading: 'done', rows }
}

function formatTokens(usage: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (usage === undefined) return undefined
  const cacheR = numberField(usage, 'cache_read_input_tokens')
  const cacheW = numberField(usage, 'cache_creation_input_tokens')
  const inTok = numberField(usage, 'input_tokens')
  const outTok = numberField(usage, 'output_tokens')
  const parts: string[] = []
  if (cacheR !== undefined || cacheW !== undefined) {
    parts.push(`cache R/W: ${humanCount(cacheR ?? 0)} / ${humanCount(cacheW ?? 0)}`)
  }
  if (inTok !== undefined) parts.push(`in: ${humanCount(inTok)}`)
  if (outTok !== undefined) parts.push(`out: ${humanCount(outTok)}`)
  if (parts.length === 0) return undefined
  return parts.join(' · ')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function middleEllipsis(p: string, max: number): string {
  if (p.length <= max) return p
  const tail = p.slice(p.lastIndexOf('/') + 1)
  if (tail.length + 4 >= max) return `…/${tail.slice(-(max - 2))}`
  return `…/${tail}`
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl === -1 ? s : s.slice(0, nl)
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function humanCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function readString(obj: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

function readObject(
  obj: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const v = obj[key]
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  return v as Readonly<Record<string, unknown>>
}

function numberField(obj: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === 'number' ? v : undefined
}

function readContentBlocks(event: InfoEvent): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const message = readObject(event.payload ?? {}, 'message')
  if (message === undefined) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const out: Array<Readonly<Record<string, unknown>>> = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      out.push(block as Readonly<Record<string, unknown>>)
    }
  }
  return out
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
