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

import {
  firstLine,
  firstNonEmptyLine,
  formatDuration,
  humanCount,
  MAX_ASSISTANT_TEXT,
  MAX_BASH_COMMAND,
  MAX_ERROR_TEXT,
  MAX_FILE_PATH,
  MAX_GENERIC_INPUT,
  MAX_TOOL_RESULT_LINE,
  middleEllipsis,
  readObject,
  readString,
  safeJson,
  truncate,
} from '../transcript-format-utils.ts'
import type { InfoEvent, RunnerEvent, TerminalEvent, TranscriptLine } from '../types.ts'

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
