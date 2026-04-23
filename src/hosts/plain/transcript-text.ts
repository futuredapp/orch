// ---------------------------------------------------------------------------
// transcript-text — pure RunnerEvent → line renderer, shared across hosts.
// ---------------------------------------------------------------------------
//
// Phase A uses this for `--mode=plain --format=text`. Phase D reuses the same
// function inside the two-pane transcript renderer — that's why the output
// is the step-agnostic body; the host prefixes with `[<stepName>]` when it
// writes. Every line passes through `stripAnsi` so OSC/DCS/C1 poisoning
// can't reach the terminal (see strip-ansi.ts).

import type { InfoEvent, RunnerEvent } from '../../runners/index.ts'
import { stripAnsi } from './strip-ansi.ts'

const MAX_ARG_PREVIEW = 80

/**
 * Render a single `RunnerEvent` as one human-readable line. Returns `null`
 * for events that should be suppressed from the transcript (e.g. internal
 * `info:session` chatter). Callers are expected to skip `null` lines rather
 * than print an empty string.
 */
export function renderTranscriptLine(event: RunnerEvent): string | null {
  if (event.kind === 'terminal') {
    if (event.type === 'error') {
      return `✗ error: ${stripAnsi(event.message)}`
    }
    // `turn-complete` is a lifecycle bookend; suppress from the readable
    // transcript — the left-pane status view already marks the step done.
    return null
  }

  return renderInfoEvent(event)
}

function renderInfoEvent(event: InfoEvent): string | null {
  switch (event.type) {
    case 'assistant':
      return renderAssistant(event)
    case 'tool_use':
      return renderToolUse(event)
    case 'tool_result':
      return renderToolResult(event)
    default:
      // Unknown info event — keep it visible so we never silently drop
      // runner output, but normalise shape.
      return `· ${event.type}`
  }
}

function renderAssistant(event: InfoEvent): string | null {
  const text = readStringField(event.payload, 'text')
  if (text === undefined) return null
  const cleaned = stripAnsi(text).trim()
  if (cleaned.length === 0) return null
  return `assistant> ${cleaned}`
}

function renderToolUse(event: InfoEvent): string {
  const name = readStringField(event.payload, 'name') ?? 'tool'
  const argsRepr = renderToolArgs(event.payload)
  return `▸ tool: ${name}(${argsRepr})`
}

function renderToolResult(event: InfoEvent): string {
  const name = readStringField(event.payload, 'name') ?? 'tool'
  const text = readStringField(event.payload, 'text')
  if (text !== undefined) {
    const cleaned = stripAnsi(text).trim().split('\n')[0] ?? ''
    return `◂ ${name}: ${truncate(cleaned, MAX_ARG_PREVIEW)}`
  }
  return `◂ ${name}`
}

function renderToolArgs(payload: InfoEvent['payload']): string {
  if (payload === undefined) return ''
  const args = payload.args ?? payload.input
  if (args === undefined) return ''
  try {
    const serialised = typeof args === 'string' ? args : JSON.stringify(args)
    return stripAnsi(truncate(serialised, MAX_ARG_PREVIEW))
  } catch {
    return '…'
  }
}

function readStringField(payload: InfoEvent['payload'], key: string): string | undefined {
  if (payload === undefined) return undefined
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
