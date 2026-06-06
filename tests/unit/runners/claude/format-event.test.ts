// MIGRATED → tests-new/unit/runners/claude/format-event.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit tests for the Claude RunnerEvent → TranscriptLine formatter.
//
// One assertion per test; full-sentence test names. Each test exercises one
// branch of `toClaudeTranscriptLines` against a hand-rolled envelope so the
// behaviour is exact and review-friendly.

import { describe, expect, it } from 'bun:test'
import { toClaudeTranscriptLines } from '../../../../src/runners/claude/format-event.ts'
import type { InfoEvent, RunnerEvent, TerminalEvent } from '../../../../src/runners/types.ts'

function info(type: string, payload: Record<string, unknown>): InfoEvent {
  return { kind: 'info', type, payload }
}

function assistantWithContent(content: ReadonlyArray<Record<string, unknown>>): InfoEvent {
  return info('assistant', { message: { role: 'assistant', content } })
}

function userWithContent(content: ReadonlyArray<Record<string, unknown>>): InfoEvent {
  return info('user', { message: { role: 'user', content } })
}

describe.skip('toClaudeTranscriptLines — system init', () => {
  it('renders the synthesized session-started event as one line with model, tool count, and mcp server count', () => {
    const evt = info('session-started', {
      sessionId: 'sess-1',
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7[1m]',
      tools: ['Read', 'Write', 'Bash'],
      mcp_servers: [{ name: 'a' }, { name: 'b' }],
    })

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toEqual([
      {
        kind: 'line',
        category: 'system',
        body: 'system: model=claude-opus-4-7[1m], 3 tools, 2 mcp servers',
      },
    ])
  })

  it('renders a raw system-init event that bypassed the parser as the init line', () => {
    const evt = info('system', {
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-7[1m]',
      tools: ['Read'],
      mcp_servers: [],
    })

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toEqual([
      {
        kind: 'line',
        category: 'system',
        body: 'system: model=claude-opus-4-7[1m], 1 tools, 0 mcp servers',
      },
    ])
  })
})

describe.skip('toClaudeTranscriptLines — non-init system events', () => {
  it('suppresses high-frequency task_progress system events emitted by background workflows', () => {
    const evt = info('system', { type: 'system', subtype: 'task_progress', taskId: 'wa9h5dr4w' })

    expect(toClaudeTranscriptLines(evt)).toEqual([])
  })

  it('suppresses thinking_tokens system events', () => {
    const evt = info('system', { type: 'system', subtype: 'thinking_tokens', tokens: 42 })

    expect(toClaudeTranscriptLines(evt)).toEqual([])
  })

  it('renders a lifecycle system subtype as one compact line rather than a bogus init summary', () => {
    const evt = info('system', { type: 'system', subtype: 'task_started', taskId: 'wa9h5dr4w' })

    expect(toClaudeTranscriptLines(evt)).toEqual([
      { kind: 'line', category: 'system', body: '· task_started' },
    ])
  })

  it('renders a system event with no subtype as a bare system marker, never a fake init line', () => {
    const evt = info('system', { type: 'system' })

    expect(toClaudeTranscriptLines(evt)).toEqual([
      { kind: 'line', category: 'system', body: '· system' },
    ])
  })
})

describe.skip('toClaudeTranscriptLines — assistant messages', () => {
  it('expands an assistant message into ordered lines per content block (thinking, tool_use, text)', () => {
    const evt = assistantWithContent([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.txt' } },
      { type: 'text', text: 'done' },
    ])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toEqual([
      { kind: 'line', category: 'thinking', label: 'thinking', body: '' },
      { kind: 'line', category: 'tool-call', label: 'Read', body: '(/a.txt)' },
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'done' },
    ])
  })

  it('renders multiple text blocks in a single assistant message as separate lines', () => {
    const evt = assistantWithContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toHaveLength(2)
    expect(lines.map((l) => (l.kind === 'line' ? l.body : ''))).toEqual(['first', 'second'])
  })

  it('truncates a 50KB assistant text block to 4000 chars', () => {
    const huge = 'x'.repeat(50_000)
    const evt = assistantWithContent([{ type: 'text', text: huge }])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toHaveLength(1)
    const first = lines[0]
    if (first?.kind !== 'line') throw new Error('expected line')
    expect(first.body.length).toBe(4000)
    expect(first.body.endsWith('…')).toBe(true)
  })

  it('skips empty text blocks rather than emitting a label-only assistant line', () => {
    const evt = assistantWithContent([{ type: 'text', text: '' }])

    expect(toClaudeTranscriptLines(evt)).toEqual([])
  })
})

describe.skip('toClaudeTranscriptLines — tool_use formatting', () => {
  it('renders Read tool_use with middle-ellipsis on a long file path', () => {
    const longPath = `/Users/foo/very/long/intermediate/path/segments/that/keeps/going/${'x'.repeat(80)}.txt`
    const evt = assistantWithContent([
      { type: 'tool_use', name: 'Read', input: { file_path: longPath } },
    ])

    const lines = toClaudeTranscriptLines(evt)

    const first = lines[0]
    if (first?.kind !== 'line') throw new Error('expected line')
    expect(first.body.startsWith('(…/')).toBe(true)
    expect(first.body.endsWith(')')).toBe(true)
    // Body content (between the parens) must be ≤ 60 chars per truncation rule.
    expect(first.body.slice(1, -1).length).toBeLessThanOrEqual(60)
  })

  it('renders Bash tool_use with command truncated at 120 chars', () => {
    const cmd = `echo ${'a'.repeat(200)}`
    const evt = assistantWithContent([{ type: 'tool_use', name: 'Bash', input: { command: cmd } }])

    const lines = toClaudeTranscriptLines(evt)

    const first = lines[0]
    if (first?.kind !== 'line') throw new Error('expected line')
    expect(first.body.length).toBe(120)
    expect(first.body.endsWith('…')).toBe(true)
  })

  it('renders TodoWrite tool_use with the todo count', () => {
    const evt = assistantWithContent([
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [{}, {}, {}, {}] } },
    ])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines[0]).toEqual({
      kind: 'line',
      category: 'tool-call',
      label: 'TodoWrite',
      body: '<4 todos>',
    })
  })

  it('renders an unknown tool_use as JSON-stringified input truncated at 80', () => {
    const evt = assistantWithContent([
      {
        type: 'tool_use',
        name: 'CustomTool',
        input: { url: 'https://example.com', query: 'a'.repeat(120) },
      },
    ])

    const lines = toClaudeTranscriptLines(evt)

    const first = lines[0]
    if (first?.kind !== 'line') throw new Error('expected line')
    expect(first.label).toBe('CustomTool')
    expect(first.body.length).toBe(80)
    expect(first.body.endsWith('…')).toBe(true)
  })
})

describe.skip('toClaudeTranscriptLines — tool_result formatting', () => {
  it('renders a tool_result with is_error=true as the tool-error category', () => {
    const evt = userWithContent([
      {
        type: 'tool_result',
        is_error: true,
        content: '<tool_use_error>boom</tool_use_error>',
        tool_use_id: 't1',
      },
    ])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toHaveLength(1)
    const first = lines[0]
    if (first?.kind !== 'line') throw new Error('expected line')
    expect(first.category).toBe('tool-error')
    expect(first.body).toBe('<tool_use_error>boom</tool_use_error>')
  })

  it('renders a tool_result with multi-line content as the first non-empty line', () => {
    const evt = userWithContent([
      {
        type: 'tool_result',
        content: '\n\n  hello world  \nignored second line',
        tool_use_id: 't1',
      },
    ])

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toEqual([{ kind: 'line', category: 'tool-result', body: 'hello world' }])
  })
})

describe.skip('toClaudeTranscriptLines — terminal events', () => {
  it('renders turn-complete as a done block with rows present in usage', () => {
    const evt: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        result: 'Solved.',
        duration_ms: 22216,
        num_turns: 6,
        total_cost_usd: 0.014_2,
        usage: {
          input_tokens: 4100,
          output_tokens: 612,
          cache_creation_input_tokens: 29_206,
          cache_read_input_tokens: 143_292,
        },
        permission_denials: [],
        session_id: 'sess-abc',
      },
    }

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toHaveLength(1)
    const first = lines[0]
    if (first?.kind !== 'block') throw new Error('expected block')
    expect(first.heading).toBe('done')
    const labels = first.rows.map(([l]) => l)
    expect(labels).toEqual([
      'result',
      'duration',
      'turns',
      'cost',
      'tokens',
      'permissions',
      'session',
    ])
    const rowMap = Object.fromEntries(first.rows)
    expect(rowMap.duration).toBe('22.2s')
    expect(rowMap.cost).toBe('$0.0142')
    expect(rowMap.tokens).toBe('cache R/W: 143k / 29k · in: 4k · out: 612')
    expect(rowMap.permissions).toBe('0 denials')
  })

  it('renders turn-complete with partial usage by emitting only present rows', () => {
    const evt: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: { result: 'ok' },
    }

    const lines = toClaudeTranscriptLines(evt)

    const first = lines[0]
    if (first?.kind !== 'block') throw new Error('expected block')
    expect(first.rows.map(([l]) => l)).toEqual(['result'])
  })

  it('renders terminal/error as a failed block with the message row', () => {
    const evt: RunnerEvent = { kind: 'terminal', type: 'error', message: 'auth failed' }

    const lines = toClaudeTranscriptLines(evt)

    expect(lines).toEqual([
      { kind: 'block', heading: 'failed', rows: [['message', 'auth failed']] },
    ])
  })
})

describe.skip('toClaudeTranscriptLines — suppression and edge cases', () => {
  it('returns [] for rate_limit_event, missing content, and empty content', () => {
    expect(toClaudeTranscriptLines(info('rate_limit_event', { foo: 'bar' }))).toEqual([])
    expect(toClaudeTranscriptLines(info('assistant', { message: { content: [] } }))).toEqual([])
    expect(toClaudeTranscriptLines(info('assistant', {}))).toEqual([])
  })
})
