import { describe, expect, it } from 'bun:test'
import { classifyClaudeError } from '../../../../src/runners/claude/classify-error.ts'
import type {
  ClassifyErrorSignal,
  InfoEvent,
  TerminalEvent,
} from '../../../../src/runners/types.ts'

function errorTerminal(data?: Record<string, unknown>): TerminalEvent {
  return { kind: 'terminal', type: 'error', message: 'boom', ...(data ? { data } : {}) }
}

function apiRetry(errorStatus: number, extra: Record<string, unknown> = {}): InfoEvent {
  return {
    kind: 'info',
    type: 'system',
    payload: { subtype: 'api_retry', error_status: errorStatus, error: 'rate_limit', ...extra },
  }
}

function signal(overrides: Partial<ClassifyErrorSignal>): ClassifyErrorSignal {
  return { finalEvent: errorTerminal(), exitCode: 1, infoEvents: [], ...overrides }
}

describe('classifyClaudeError', () => {
  it('classifies api_error_status 529 on the result envelope as overload despite an untrusted "rate_limit" label', () => {
    const s = signal({
      finalEvent: errorTerminal({ api_error_status: 529, error: 'rate_limit', subtype: 'success' }),
    })

    const classified = classifyClaudeError(s)

    expect(classified.category).toBe('overload')
    expect(classified.transient).toBe(true)
    expect(classified.httpStatus).toBe(529)
  })

  it('reads error_status from the newest api_retry info event when the terminal event carries no status', () => {
    const s = signal({
      finalEvent: errorTerminal(),
      infoEvents: [apiRetry(503), apiRetry(529)],
    })

    const classified = classifyClaudeError(s)

    expect(classified.category).toBe('overload')
    expect(classified.httpStatus).toBe(529)
  })

  it('maps 503 to overload, 500 to server_error, and 401 to auth', () => {
    expect(
      classifyClaudeError(signal({ finalEvent: errorTerminal({ api_error_status: 503 }) }))
        .category,
    ).toBe('overload')
    expect(
      classifyClaudeError(signal({ finalEvent: errorTerminal({ api_error_status: 500 }) }))
        .category,
    ).toBe('server_error')
    const auth = classifyClaudeError(
      signal({ finalEvent: errorTerminal({ api_error_status: 401 }) }),
    )
    expect(auth.category).toBe('auth')
    expect(auth.transient).toBe(false)
  })

  it('classifies a bare 429 (no reset info) as rate_limit, fail-fast', () => {
    const classified = classifyClaudeError(
      signal({ finalEvent: errorTerminal({ api_error_status: 429 }) }),
    )

    expect(classified.category).toBe('rate_limit')
    expect(classified.transient).toBe(false)
    expect(classified.resetsAt).toBeUndefined()
  })

  it('refines a 429 carrying reset info to usage_limit and surfaces resetsAt', () => {
    const resetsAtSeconds = 1_780_000_000
    const classified = classifyClaudeError(
      signal({ finalEvent: errorTerminal({ api_error_status: 429, resets_at: resetsAtSeconds }) }),
    )

    expect(classified.category).toBe('usage_limit')
    expect(classified.transient).toBe(false)
    expect(classified.resetsAt).toBe(resetsAtSeconds * 1000)
  })

  it('falls back to unknown/retryable when no numeric status is recoverable', () => {
    const s = signal({
      finalEvent: errorTerminal({ error: 'rate_limit', isApiErrorMessage: true }),
      infoEvents: [],
    })

    const classified = classifyClaudeError(s)

    expect(classified.category).toBe('unknown')
    expect(classified.transient).toBe(true)
    expect(classified.httpStatus).toBeUndefined()
  })

  it('ignores a null api_error_status (the success-envelope shape) and looks no further when nothing else carries a status', () => {
    const classified = classifyClaudeError(
      signal({ finalEvent: errorTerminal({ api_error_status: null }) }),
    )

    expect(classified.category).toBe('unknown')
  })
})
