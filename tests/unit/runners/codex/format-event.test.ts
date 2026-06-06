// MIGRATED → tests-new/unit/runners/codex/format-event.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { toCodexTranscriptLines } from '../../../../src/runners/codex/format-event.ts'
import type { InfoEvent, TerminalEvent } from '../../../../src/runners/types.ts'

function infoEvent(type: string, payload: Readonly<Record<string, unknown>> = {}): InfoEvent {
  return { kind: 'info', type, payload }
}

function itemCompleted(item: Readonly<Record<string, unknown>>): InfoEvent {
  return infoEvent('item.completed', { item })
}

describe.skip('toCodexTranscriptLines — info dispatch', () => {
  it('dispatches item.completed events to the per-item formatter', () => {
    const lines = toCodexTranscriptLines(
      itemCompleted({ id: 'i1', type: 'agent_message', text: 'hi' }),
    )

    expect(lines).toEqual([
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'hi' },
    ])
  })

  it.each([
    'item.started',
    'turn.started',
    'thread.started',
  ] as const)('returns an empty list for the suppressed event type %s', (type) => {
    const lines = toCodexTranscriptLines(infoEvent(type))

    expect(lines).toEqual([])
  })

  it('renders an unknown info event.type as a single system fallback line', () => {
    const lines = toCodexTranscriptLines(infoEvent('future.surprise'))

    expect(lines).toEqual([{ kind: 'line', category: 'system', body: '· future.surprise' }])
  })
})

describe.skip('toCodexTranscriptLines — item.completed: agent_message', () => {
  it('renders agent_message as an assistant line, truncated at MAX_ASSISTANT_TEXT', () => {
    const longText = 'a'.repeat(5000)
    const lines = toCodexTranscriptLines(
      itemCompleted({ id: 'i1', type: 'agent_message', text: longText }),
    )

    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line).toBeDefined()
    if (line && line.kind === 'line') {
      expect(line.category).toBe('assistant')
      expect(line.label).toBe('assistant>')
      expect(line.body.endsWith('…')).toBe(true)
      expect(line.body.length).toBe(4000)
    }
  })
})

describe.skip('toCodexTranscriptLines — item.completed: reasoning', () => {
  it('renders reasoning as a thinking marker line with no body', () => {
    const lines = toCodexTranscriptLines(itemCompleted({ id: 'i1', type: 'reasoning' }))

    expect(lines).toEqual([{ kind: 'line', category: 'thinking', label: 'thinking', body: '' }])
  })
})

describe.skip('toCodexTranscriptLines — item.completed: command_execution', () => {
  it('renders successful command_execution as a tool-call bash line with the first line of the command, truncated', () => {
    const lines = toCodexTranscriptLines(
      itemCompleted({
        id: 'i1',
        type: 'command_execution',
        command: '/bin/zsh -lc ls\nshould-not-render',
        exit_code: 0,
      }),
    )

    expect(lines).toEqual([
      { kind: 'line', category: 'tool-call', label: 'bash', body: '/bin/zsh -lc ls' },
    ])
  })

  it('renders non-zero exit command_execution as a tool-error with the exit code appended on a second line', () => {
    const lines = toCodexTranscriptLines(
      itemCompleted({
        id: 'i1',
        type: 'command_execution',
        command: '/bin/zsh -lc ls',
        exit_code: 2,
      }),
    )

    expect(lines).toEqual([
      {
        kind: 'line',
        category: 'tool-error',
        label: 'bash',
        body: '/bin/zsh -lc ls\n  exit 2',
      },
    ])
  })
})

describe.skip('toCodexTranscriptLines — item.completed: file_change', () => {
  it('renders file_change as a tool-call edit line with a middle-ellipsised path', () => {
    const longPath = '/very/long/nested/directory/structure/leading/to/some/deep/file.ts'
    const lines = toCodexTranscriptLines(
      itemCompleted({ id: 'i1', type: 'file_change', path: longPath }),
    )

    expect(lines).toHaveLength(1)
    const [line] = lines
    if (line && line.kind === 'line') {
      expect(line.category).toBe('tool-call')
      expect(line.label).toBe('edit')
      expect(line.body.startsWith('(')).toBe(true)
      expect(line.body.endsWith(')')).toBe(true)
      expect(line.body).toContain('file.ts')
      expect(line.body).toContain('…')
    }
  })
})

describe.skip('toCodexTranscriptLines — item.completed: mcp_tool_call', () => {
  it.each([
    ['success', false, 'tool-call'],
    ['error', true, 'tool-error'],
  ] as const)('renders mcp_tool_call as %s when is_error=%p', (_label, isError, expectedCategory) => {
    const lines = toCodexTranscriptLines(
      itemCompleted({
        id: 'i1',
        type: 'mcp_tool_call',
        server: 'fs',
        tool: 'read',
        arguments: { path: '/tmp/foo' },
        is_error: isError,
      }),
    )

    expect(lines).toHaveLength(1)
    const [line] = lines
    if (line && line.kind === 'line') {
      expect(line.category).toBe(expectedCategory)
      expect(line.label).toBe('mcp:fs:read')
      expect(line.body).toContain('/tmp/foo')
    }
  })
})

describe.skip('toCodexTranscriptLines — item.completed: web_search', () => {
  it('renders web_search as a tool-call web line with the query', () => {
    const lines = toCodexTranscriptLines(
      itemCompleted({ id: 'i1', type: 'web_search', query: 'rust ratatui colors' }),
    )

    expect(lines).toEqual([
      { kind: 'line', category: 'tool-call', label: 'web', body: 'rust ratatui colors' },
    ])
  })
})

describe.skip('toCodexTranscriptLines — item.completed: error', () => {
  it('renders an error item as a tool-error line with the message truncated at MAX_ERROR_TEXT', () => {
    const longMsg = 'x'.repeat(300)
    const lines = toCodexTranscriptLines(
      itemCompleted({ id: 'i1', type: 'error', message: longMsg }),
    )

    expect(lines).toHaveLength(1)
    const [line] = lines
    if (line && line.kind === 'line') {
      expect(line.category).toBe('tool-error')
      expect(line.body.endsWith('…')).toBe(true)
      expect(line.body.length).toBe(200)
    }
  })
})

describe.skip('toCodexTranscriptLines — item.completed: unknown item.type', () => {
  it('renders an unknown item.type as a single system fallback line', () => {
    const lines = toCodexTranscriptLines(itemCompleted({ id: 'i1', type: 'future_thing' }))

    expect(lines).toEqual([{ kind: 'line', category: 'system', body: '· item.future_thing' }])
  })
})

describe.skip('toCodexTranscriptLines — terminal events', () => {
  it('renders turn-complete as a done block with tokens, cache, reasoning, and a truncated result row, omitting rows whose data is absent', () => {
    const event: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cached_input_tokens: 800,
          reasoning_output_tokens: 250,
        },
        _accumulatedText: 'final answer goes here',
      },
    }

    const [line] = toCodexTranscriptLines(event)
    expect(line).toBeDefined()
    if (line && line.kind === 'block') {
      expect(line.heading).toBe('done')
      expect(line.rows).toEqual([
        ['tokens', 'in: 1k · out: 567'],
        ['cache', '800'],
        ['reasoning', '250'],
        ['result', 'final answer goes here'],
      ])
    }
  })

  it('renders error terminal as a failed block with one message row', () => {
    const event: TerminalEvent = {
      kind: 'terminal',
      type: 'error',
      message: 'Rate limit exceeded',
    }

    expect(toCodexTranscriptLines(event)).toEqual([
      { kind: 'block', heading: 'failed', rows: [['message', 'Rate limit exceeded']] },
    ])
  })
})
