import { describe, expect, it } from 'bun:test'
import { parseClaudeLine } from '../../../../src/runners/claude/index.ts'

// The recovery classifier (classify-error.ts) reads the numeric HTTP status from
// fields parseClaudeLine must preserve verbatim: `error_status` on api_retry
// system events and `api_error_status` on the result envelope, plus the
// `isApiErrorMessage` marker on the synthetic terminal turn. These tests pin
// that contract so a future parser refactor cannot silently swallow the signal
// the recovery loop depends on (R5).
describe('parseClaudeLine — recovery signal preservation', () => {
  it('preserves error_status and subtype on an api_retry system event payload', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      error_status: 529,
      error: 'rate_limit',
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('info')
    if (evt?.kind === 'info') {
      expect(evt.payload?.subtype).toBe('api_retry')
      expect(evt.payload?.error_status).toBe(529)
    }
  })

  it('preserves api_error_status on the result-envelope terminal data', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error',
      session_id: 's1',
      duration_ms: 10,
      is_error: true,
      errors: ['API Error: 529'],
      api_error_status: 529,
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('terminal')
    if (evt?.kind === 'terminal' && evt.type === 'error') {
      const data = evt.data as Record<string, unknown>
      expect(data.api_error_status).toBe(529)
    }
  })

  it('preserves isApiErrorMessage and the synthetic model marker on the terminal assistant turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: 529' }],
      },
      error: 'rate_limit',
      isApiErrorMessage: true,
    })

    const evt = parseClaudeLine(line)

    expect(evt?.kind).toBe('info')
    if (evt?.kind === 'info') {
      expect(evt.payload?.isApiErrorMessage).toBe(true)
      const message = evt.payload?.message as Record<string, unknown>
      expect(message.model).toBe('<synthetic>')
    }
  })
})
