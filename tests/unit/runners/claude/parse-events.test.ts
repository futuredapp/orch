import { describe, expect, it } from 'bun:test'
import { claude, parseClaudeLine } from '../../../../src/runners/claude/index.ts'
import type { TerminalEvent } from '../../../../src/runners/types.ts'

describe('parseClaudeLine', () => {
  it('parses a success result into a turn-complete TerminalEvent with envelope in data', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Hello!',
      session_id: 'sess-001',
      duration_ms: 1000,
      duration_api_ms: 900,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })

    const evt = parseClaudeLine(line)

    expect(evt).not.toBeNull()
    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('turn-complete')
    expect((evt as TerminalEvent & { data?: unknown }).data).toBeDefined()
  })

  it('parses an error result into an error TerminalEvent with message from errors[0]', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-002',
      duration_ms: 5000,
      is_error: true,
      errors: ['Max turns reached (5)'],
    })

    const evt = parseClaudeLine(line)

    expect(evt).not.toBeNull()
    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Max turns reached (5)')
    }
  })

  it('uses "unknown error" when errors array is empty', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      session_id: 'sess-003',
      duration_ms: 100,
      is_error: true,
      errors: [],
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('unknown error')
    }
  })

  it('parses success with is_error: true as turn-complete (not rejected)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'partial auth',
      session_id: 'sess-004',
      duration_ms: 200,
      duration_api_ms: 100,
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('turn-complete')
  })

  it('parses unknown error subtype successfully (not rejected by enum)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_future_unknown_type',
      session_id: 'sess-005',
      duration_ms: 100,
      is_error: true,
      errors: ['Something new happened'],
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Something new happened')
    }
  })

  it('parses an unknown event type as an InfoEvent with raw type and payload', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      session_id: 'sess-006',
    })

    const evt = parseClaudeLine(line)

    expect(evt).not.toBeNull()
    expect(evt?.kind).toBe('info')
    expect(evt?.type).toBe('assistant')
    if (evt?.kind === 'info') {
      expect(evt.payload?.session_id).toBe('sess-006')
    }
  })

  it('returns null for malformed JSON', () => {
    const evt = parseClaudeLine('{not valid json')

    expect(evt).toBeNull()
  })

  it('returns null for JSON without a type field', () => {
    const evt = parseClaudeLine(JSON.stringify({ subtype: 'success', result: 'no type' }))

    expect(evt).toBeNull()
  })

  it('returns null for empty/whitespace lines', () => {
    expect(parseClaudeLine('')).toBeNull()
    expect(parseClaudeLine('   ')).toBeNull()
    expect(parseClaudeLine('\n')).toBeNull()
  })

  it('returns null for non-object JSON (string, number, array)', () => {
    expect(parseClaudeLine('"hello"')).toBeNull()
    expect(parseClaudeLine('42')).toBeNull()
    expect(parseClaudeLine('[1,2,3]')).toBeNull()
  })

  it('returns an error TerminalEvent with Zod issues for result with invalid schema', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      // missing required fields: result, session_id, duration_ms, etc.
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toContain('Malformed result envelope')
    }
  })

  it('preserves extra fields via passthrough on success results', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'OK',
      session_id: 'sess-007',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        extra_usage_field: 99,
      },
      uuid: 'uuid-extra',
      terminal_reason: 'completed',
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('turn-complete')
    if (evt?.kind === 'terminal' && evt.type === 'turn-complete') {
      const data = evt.data as Record<string, unknown>
      expect(data.uuid).toBe('uuid-extra')
      expect(data.terminal_reason).toBe('completed')
    }
  })

  it('preserves extra fields on error result data', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 'sess-008',
      duration_ms: 3000,
      is_error: true,
      errors: ['Stopped'],
      uuid: 'uuid-err',
    })

    const evt = parseClaudeLine(line)

    if (evt?.kind === 'terminal' && evt.type === 'error') {
      const data = evt.data as Record<string, unknown>
      expect(data.uuid).toBe('uuid-err')
      expect(data.subtype).toBe('error_max_turns')
    }
  })
})

describe('extractStructuredOutput', () => {
  it('returns the result text from a success terminal event', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        type: 'result',
        subtype: 'success',
        result: 'The answer is 42',
        session_id: 'sess-100',
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.005,
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toBe('The answer is 42')
  })

  it('returns undefined for an error terminal event', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'error',
      message: 'something broke',
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toBeUndefined()
  })

  it('returns undefined when turn-complete has no valid data', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: { unexpected: 'shape' },
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toBeUndefined()
  })
})
