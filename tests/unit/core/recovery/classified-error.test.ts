import { describe, expect, it } from 'bun:test'
import {
  categoryForStatus,
  FAIL_FAST_CATEGORIES,
  isFailFast,
  isLaunchFailureSignal,
  isTransientCategory,
} from '../../../../src/core/recovery/index.ts'

describe('categoryForStatus', () => {
  it('maps 529 to overload', () => {
    expect(categoryForStatus(529)).toBe('overload')
  })

  it('maps 503 to overload', () => {
    expect(categoryForStatus(503)).toBe('overload')
  })

  it('maps 500 to server_error', () => {
    expect(categoryForStatus(500)).toBe('server_error')
  })

  it('maps an arbitrary other 5xx to server_error', () => {
    expect(categoryForStatus(502)).toBe('server_error')
  })

  it('maps 429 to rate_limit', () => {
    expect(categoryForStatus(429)).toBe('rate_limit')
  })

  it('maps 401 to auth', () => {
    expect(categoryForStatus(401)).toBe('auth')
  })

  it('maps 403 to auth', () => {
    expect(categoryForStatus(403)).toBe('auth')
  })

  it('maps an unrecognized status to unknown so it stays retryable rather than fail-fast', () => {
    expect(categoryForStatus(418)).toBe('unknown')
  })
})

describe('isFailFast', () => {
  it('treats auth, billing, invalid_request, model_not_found, launch, rate_limit, and usage_limit as fail-fast', () => {
    expect(isFailFast('auth')).toBe(true)
    expect(isFailFast('billing')).toBe(true)
    expect(isFailFast('invalid_request')).toBe(true)
    expect(isFailFast('model_not_found')).toBe(true)
    expect(isFailFast('launch')).toBe(true)
    expect(isFailFast('rate_limit')).toBe(true)
    expect(isFailFast('usage_limit')).toBe(true)
  })

  it('treats overload, server_error, and unknown as not fail-fast', () => {
    expect(isFailFast('overload')).toBe(false)
    expect(isFailFast('server_error')).toBe(false)
    expect(isFailFast('unknown')).toBe(false)
  })
})

describe('isTransientCategory', () => {
  it('is the inverse of isFailFast for the retry classes', () => {
    expect(isTransientCategory('overload')).toBe(true)
    expect(isTransientCategory('server_error')).toBe(true)
    expect(isTransientCategory('unknown')).toBe(true)
  })

  it('is false for the fail-fast classes', () => {
    expect(isTransientCategory('auth')).toBe(false)
    expect(isTransientCategory('usage_limit')).toBe(false)
  })
})

describe('FAIL_FAST_CATEGORIES', () => {
  it('exposes exactly the seven fail-fast categories', () => {
    expect(FAIL_FAST_CATEGORIES.size).toBe(7)
  })
})

describe('isLaunchFailureSignal', () => {
  it('is true for a non-zero exit with no info events and a non-empty stderr tail', () => {
    expect(
      isLaunchFailureSignal({ exitCode: 1, infoEvents: [], stderr: 'Error loading rules' }),
    ).toBe(true)
  })

  it('is false when stderr is empty (an unreadable failure stays unknown/retryable)', () => {
    expect(isLaunchFailureSignal({ exitCode: 1, infoEvents: [], stderr: '   ' })).toBe(false)
  })

  it('is false when the process emitted stdout info events (it did real work first)', () => {
    expect(isLaunchFailureSignal({ exitCode: 1, infoEvents: [{}], stderr: 'late noise' })).toBe(
      false,
    )
  })

  it('is false on a clean (zero) exit even with stderr noise', () => {
    expect(isLaunchFailureSignal({ exitCode: 0, infoEvents: [], stderr: 'a warning' })).toBe(false)
  })
})
