import { describe, expect, it } from 'bun:test'
import { codex, parseCodexLine } from '../../../../src/runners/codex/index.ts'
import type { TerminalEvent } from '../../../../src/runners/types.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'

describe('parseCodexLine', () => {
  it('surfaces thread.started as a session-started info event with sessionId in payload', () => {
    // Phase 3: parseCodexLine synthesizes a `session-started` event for any
    // `thread.started` line carrying a `thread_id` so the workflow executor
    // can capture the resume identifier through the same shape Claude exposes
    // for system-init.
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' })

    const evt = parseCodexLine(line)

    expect(evt).not.toBeNull()
    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('session-started')
    if (evt?.kind === 'info') {
      expect(evt.payload?.sessionId).toBe('thread-abc')
      // Original payload is preserved so any downstream consumer that wanted
      // the legacy field can still read it.
      expect(evt.payload?.thread_id).toBe('thread-abc')
    }
  })

  it('parses turn.started as info event', () => {
    const evt = parseCodexLine(JSON.stringify({ type: 'turn.started' }))

    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('turn.started')
  })

  it('parses item.started as info event', () => {
    const evt = parseCodexLine(
      JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'agent_message' } }),
    )

    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('item.started')
  })

  it('parses item.completed as info event', () => {
    const evt = parseCodexLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: 'hello' },
      }),
    )

    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('item.completed')
  })

  it('parses turn.completed as terminal turn-complete with usage data', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 25 },
    })

    const evt = parseCodexLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('turn-complete')
    if (evt?.kind === 'terminal' && evt.type === 'turn-complete') {
      const data = evt.data as Record<string, unknown>
      const usage = data.usage as Record<string, unknown>
      expect(usage.input_tokens).toBe(100)
      expect(usage.output_tokens).toBe(25)
    }
  })

  it('parses turn.failed as terminal error with message', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Rate limit exceeded' },
    })

    const evt = parseCodexLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Rate limit exceeded')
    }
  })

  it('parses stream-level error as terminal error with message', () => {
    const line = JSON.stringify({ type: 'error', message: 'Connection failed' })

    const evt = parseCodexLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Connection failed')
    }
  })

  it('parses stream-level error without message field as "unknown error"', () => {
    const evt = parseCodexLine(JSON.stringify({ type: 'error' }))

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('unknown error')
    }
  })

  it('parses unknown event types as info passthrough', () => {
    const evt = parseCodexLine(JSON.stringify({ type: 'future.new_event', some_field: 'value' }))

    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('future.new_event')
    if (evt?.kind === 'info') {
      expect(evt.payload?.some_field).toBe('value')
    }
  })

  it('returns null for malformed JSON', () => {
    expect(parseCodexLine('{not valid json')).toBeNull()
  })

  it('returns null for empty/whitespace lines', () => {
    expect(parseCodexLine('')).toBeNull()
    expect(parseCodexLine('   ')).toBeNull()
    expect(parseCodexLine('\n')).toBeNull()
  })

  it('returns null for JSON without type field', () => {
    expect(parseCodexLine(JSON.stringify({ data: 'no type' }))).toBeNull()
  })

  it('returns null for non-object JSON (string, number, array)', () => {
    expect(parseCodexLine('"hello"')).toBeNull()
    expect(parseCodexLine('42')).toBeNull()
    expect(parseCodexLine('[1,2,3]')).toBeNull()
  })
})

describe('extractStructuredOutput', () => {
  function makeDeps(): { fs: FakeFsService; ps: FakeProcessService } {
    const fs = new FakeFsService()
    const ps = new FakeProcessService()
    ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.120.0'], exitCode: 0 })
    return { fs, ps }
  }

  it('returns parsed JSON from _accumulatedText in terminal data', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    // Simulate item.completed with agent_message containing JSON
    runner.parseEvents(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: '{"title":"Report","count":3}' },
      }),
    )
    const terminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )

    const output = runner.extractStructuredOutput(terminal as TerminalEvent)

    expect(output).toEqual({ title: 'Report', count: 3 })
  })

  it('returns undefined when no agent_message was accumulated', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    const terminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )

    const output = runner.extractStructuredOutput(terminal as TerminalEvent)

    expect(output).toBeUndefined()
  })

  it('returns raw text when _accumulatedText is not valid JSON', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    runner.parseEvents(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: 'not valid json' },
      }),
    )
    const terminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )

    const output = runner.extractStructuredOutput(terminal as TerminalEvent)

    expect(output).toBe('not valid json')
  })

  it('returns undefined for error terminal event even if agent_message was accumulated', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    // Accumulate an agent_message
    runner.parseEvents(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: '{"data":"should not appear"}' },
      }),
    )

    // Then a terminal error
    const errorEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'error',
      message: 'turn failed',
    }

    const output = runner.extractStructuredOutput(errorEvent)

    expect(output).toBeUndefined()
  })

  it('returns undefined after closure reset when second invocation has no agent_message', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    // First invocation with agent_message
    runner.parseEvents(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: '{"first":true}' },
      }),
    )

    // Reset via buildCommand
    await runner.buildCommand({
      cwd: '/tmp/work' as import('../../../../src/services/types.ts').Path,
      env: {},
      prompt: 'second',
      extraArgs: [],
    })

    // Second invocation — no agent_message, just turn.completed
    const terminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )

    const output = runner.extractStructuredOutput(terminal as TerminalEvent)

    expect(output).toBeUndefined()
  })
})
