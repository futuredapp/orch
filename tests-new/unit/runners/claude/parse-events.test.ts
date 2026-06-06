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

  it('parses a success envelope with is_error: true as a terminal error carrying the result text as the message', () => {
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
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('partial auth')
    }
  })

  // Regression: claude CLI v2.1.101 emits this exact envelope when `--bare`
  // is set and no ANTHROPIC_API_KEY is available. Without the is_error branch,
  // the workflow surfaces "runner exited 1" instead of the real reason.
  it('surfaces the "Not logged in" message from a bare-mode authentication_failed envelope', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      duration_ms: 59,
      duration_api_ms: 0,
      num_turns: 1,
      result: 'Not logged in · Please run /login',
      stop_reason: 'stop_sequence',
      session_id: '93646082-377c-4bfd-8bf7-9c5b6e2fca15',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: 'completed',
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Not logged in · Please run /login')
      const data = evt.data as Record<string, unknown> | undefined
      expect(data?.session_id).toBe('93646082-377c-4bfd-8bf7-9c5b6e2fca15')
    }
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

  it('returns structured_output when present in the result envelope', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        type: 'result',
        subtype: 'success',
        result: '{"title":"Analysis"}',
        structured_output: { title: 'Analysis', items: ['a'], count: 1 },
        session_id: 'sess-200',
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toEqual({ title: 'Analysis', items: ['a'], count: 1 })
  })

  it('returns structured_output even if result is also present', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        type: 'result',
        subtype: 'success',
        result: 'plain text fallback',
        structured_output: { picked: true },
        session_id: 'sess-201',
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
        },
      },
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toEqual({ picked: true })
  })

  it('returns null structured_output as-is without falling through to result', () => {
    const runner = claude()
    const finalEvent: TerminalEvent = {
      kind: 'terminal',
      type: 'turn-complete',
      data: {
        type: 'result',
        subtype: 'success',
        result: 'should not see this',
        structured_output: null,
        session_id: 'sess-202',
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
        },
      },
    }

    const output = runner.extractStructuredOutput(finalEvent)

    expect(output).toBeNull()
  })
})

describe('parseResultEnvelope — error_max_structured_output_retries', () => {
  it('routes error_max_structured_output_retries to error terminal event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_structured_output_retries',
      session_id: 'sess-300',
      duration_ms: 3000,
      is_error: true,
      errors: ['Max structured output retries reached'],
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    expect(evt?.type).toBe('error')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      expect(evt.message).toBe('Max structured output retries reached')
    }
  })
})
