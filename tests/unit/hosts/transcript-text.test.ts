import { describe, expect, it } from 'bun:test'
import { renderTranscriptLine } from '../../../src/hosts/index.ts'
import type { RunnerEvent } from '../../../src/runners/index.ts'

describe('renderTranscriptLine', () => {
  it('renders an assistant event as "assistant> text"', () => {
    const evt: RunnerEvent = { kind: 'info', type: 'assistant', payload: { text: 'hello' } }

    expect(renderTranscriptLine(evt)).toBe('assistant> hello')
  })

  it('returns null for empty assistant text', () => {
    const evt: RunnerEvent = { kind: 'info', type: 'assistant', payload: { text: '  ' } }

    expect(renderTranscriptLine(evt)).toBeNull()
  })

  it('renders a tool_use event as "▸ tool: name(args)"', () => {
    const evt: RunnerEvent = {
      kind: 'info',
      type: 'tool_use',
      payload: { name: 'Write', args: { path: '/x.md' } },
    }

    const line = renderTranscriptLine(evt)
    expect(line).toContain('▸ tool: Write(')
    expect(line).toContain('"path"')
  })

  it('renders a tool_use event with no args as "▸ tool: name()"', () => {
    const evt: RunnerEvent = { kind: 'info', type: 'tool_use', payload: { name: 'Ping' } }

    expect(renderTranscriptLine(evt)).toBe('▸ tool: Ping()')
  })

  it('renders a tool_result event as "◂ name: first-line"', () => {
    const evt: RunnerEvent = {
      kind: 'info',
      type: 'tool_result',
      payload: { name: 'Write', text: 'ok\ntrailing noise' },
    }

    expect(renderTranscriptLine(evt)).toBe('◂ Write: ok')
  })

  it('renders an error terminal event as "✗ error: message"', () => {
    const evt: RunnerEvent = { kind: 'terminal', type: 'error', message: 'boom' }

    expect(renderTranscriptLine(evt)).toBe('✗ error: boom')
  })

  it('suppresses the turn-complete terminal event', () => {
    const evt: RunnerEvent = { kind: 'terminal', type: 'turn-complete' }

    expect(renderTranscriptLine(evt)).toBeNull()
  })

  it('strips OSC 52 clipboard escapes from assistant text', () => {
    const poison = '\x1b]52;c;cG93bmVk\x07hello'
    const evt: RunnerEvent = { kind: 'info', type: 'assistant', payload: { text: poison } }

    const line = renderTranscriptLine(evt) ?? ''
    expect(line).not.toContain('\x1b')
    expect(line).not.toContain('\x07')
    expect(line).toContain('hello')
  })

  it('strips CSI SGR color codes from assistant text', () => {
    const evt: RunnerEvent = {
      kind: 'info',
      type: 'assistant',
      payload: { text: '\x1b[31mred\x1b[0m ok' },
    }

    expect(renderTranscriptLine(evt)).toBe('assistant> red ok')
  })

  it('strips bare C1 control bytes', () => {
    const evt: RunnerEvent = {
      kind: 'info',
      type: 'assistant',
      payload: { text: 'a\x9bb' }, // CSI in 8-bit form
    }

    expect(renderTranscriptLine(evt)).toBe('assistant> ab')
  })
})
