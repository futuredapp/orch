// ---------------------------------------------------------------------------
// format-event — Codex RunnerEvent → readonly TranscriptLine[]
// ---------------------------------------------------------------------------
//
// Codex's NDJSON envelope is two-tier: terminal events (`turn.completed` /
// `turn.failed`) carry final state, and `item.completed` events carry the
// seven semantic item types (`agent_message`, `reasoning`,
// `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
// `error`). This formatter flattens each into one or more TranscriptLines,
// pre-truncated and stripped of structure the host doesn't need.
//
// All formatting is pure: no I/O, no module-level side effects, no shared
// mutable state. Helpers stay private to this file.
//
// Hosts handle ANSI, glyphs, and the `[<step>] ` prefix — categories carry
// the semantic intent, never the visual treatment.

import {
  firstLine,
  firstNonEmptyLine,
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

export function toCodexTranscriptLines(event: RunnerEvent): readonly TranscriptLine[] {
  if (event.kind === 'terminal') return formatTerminal(event)
  return formatInfo(event)
}

function formatInfo(event: InfoEvent): readonly TranscriptLine[] {
  switch (event.type) {
    case 'item.completed':
      return formatItemCompleted(event)
    // Suppressed: `item.started` is duplicated by the matching `item.completed`
    // (which carries results); `turn.started` has no useful payload;
    // `thread.started` / `session-started` are runner-internal — the
    // synthesized `session-started` type is consumed by the workflow executor
    // for sessionId capture, not the transcript renderer.
    case 'item.started':
    case 'turn.started':
    case 'thread.started':
    case 'session-started':
      return []
    default:
      return [{ kind: 'line', category: 'system', body: `· ${event.type}` }]
  }
}

function formatItemCompleted(event: InfoEvent): readonly TranscriptLine[] {
  const item = readObject(event.payload ?? {}, 'item')
  if (item === undefined) return []
  const itemType = readString(item, 'type')
  switch (itemType) {
    case 'agent_message':
      return formatAgentMessage(item)
    case 'reasoning':
      return formatReasoning()
    case 'command_execution':
      return formatCommandExecution(item)
    case 'file_change':
      return formatFileChange(item)
    case 'mcp_tool_call':
      return formatMcpToolCall(item)
    case 'web_search':
      return formatWebSearch(item)
    case 'error':
      return formatErrorItem(item)
    default:
      return [{ kind: 'line', category: 'system', body: `· item.${itemType ?? 'unknown'}` }]
  }
}

function formatAgentMessage(item: Readonly<Record<string, unknown>>): readonly TranscriptLine[] {
  const text = readString(item, 'text') ?? ''
  return [
    {
      kind: 'line',
      category: 'assistant',
      label: 'assistant>',
      body: truncate(text, MAX_ASSISTANT_TEXT),
    },
  ]
}

function formatReasoning(): readonly TranscriptLine[] {
  // Codex hides reasoning text by default; render the marker only — same
  // shape as Claude's `thinking` block.
  return [{ kind: 'line', category: 'thinking', label: 'thinking', body: '' }]
}

function formatCommandExecution(
  item: Readonly<Record<string, unknown>>,
): readonly TranscriptLine[] {
  const command = readString(item, 'command') ?? ''
  const exitCode = readNumber(item, 'exit_code')
  const body = truncate(firstLine(command), MAX_BASH_COMMAND)
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return [
      {
        kind: 'line',
        category: 'tool-error',
        label: 'bash',
        body: `${body}\n  exit ${exitCode}`,
      },
    ]
  }
  return [{ kind: 'line', category: 'tool-call', label: 'bash', body }]
}

function formatFileChange(item: Readonly<Record<string, unknown>>): readonly TranscriptLine[] {
  const filePath = readString(item, 'path') ?? ''
  return [
    {
      kind: 'line',
      category: 'tool-call',
      label: 'edit',
      body: `(${middleEllipsis(filePath, MAX_FILE_PATH)})`,
    },
  ]
}

function formatMcpToolCall(item: Readonly<Record<string, unknown>>): readonly TranscriptLine[] {
  const server = readString(item, 'server')
  const tool = readString(item, 'tool')
  const label = server && tool ? `mcp:${server}:${tool}` : 'mcp'
  const args = readObject(item, 'arguments')
  const body = truncate(safeJson(args ?? {}), MAX_GENERIC_INPUT)
  const isError = item.is_error === true
  return [
    {
      kind: 'line',
      category: isError ? 'tool-error' : 'tool-call',
      label,
      body,
    },
  ]
}

function formatWebSearch(item: Readonly<Record<string, unknown>>): readonly TranscriptLine[] {
  const query = readString(item, 'query') ?? ''
  return [
    {
      kind: 'line',
      category: 'tool-call',
      label: 'web',
      body: truncate(query, MAX_GENERIC_INPUT),
    },
  ]
}

function formatErrorItem(item: Readonly<Record<string, unknown>>): readonly TranscriptLine[] {
  const message = readString(item, 'message') ?? ''
  return [{ kind: 'line', category: 'tool-error', body: truncate(message, MAX_ERROR_TEXT) }]
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

  const usage = readObject(data, 'usage')
  const tokens = formatTokens(usage)
  if (tokens !== undefined) rows.push(['tokens', tokens])

  const cache = numberField(usage, 'cached_input_tokens')
  if (cache !== undefined) rows.push(['cache', humanCount(cache)])

  const reasoning = numberField(usage, 'reasoning_output_tokens')
  if (reasoning !== undefined) rows.push(['reasoning', humanCount(reasoning)])

  // `_accumulatedText` is stashed onto turn-complete by the runner's
  // `parseEvents` (see codex-runner.ts). The leading underscore signals the
  // runner-internal origin; we read it permissively and omit the row when
  // it's absent so the formatter stays decoupled from the runner's state.
  const result = readString(data, '_accumulatedText')
  if (result !== undefined && result.length > 0) {
    rows.push(['result', truncate(firstNonEmptyLine(result), MAX_TOOL_RESULT_LINE)])
  }

  return { kind: 'block', heading: 'done', rows }
}

function formatTokens(usage: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (usage === undefined) return undefined
  const inTok = numberField(usage, 'input_tokens')
  const outTok = numberField(usage, 'output_tokens')
  const parts: string[] = []
  if (inTok !== undefined) parts.push(`in: ${humanCount(inTok)}`)
  if (outTok !== undefined) parts.push(`out: ${humanCount(outTok)}`)
  if (parts.length === 0) return undefined
  return parts.join(' · ')
}

function readNumber(obj: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === 'number' ? v : undefined
}

function numberField(
  obj: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  if (obj === undefined) return undefined
  const v = obj[key]
  return typeof v === 'number' ? v : undefined
}
