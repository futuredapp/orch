import { describe, expect, it } from 'bun:test'
import type { ClassifiedError } from '../../../../src/core/recovery/index.ts'
import {
  type AttemptState,
  backoffResume,
  DEFAULT_CEILING,
  DEFAULT_WAIT_MS,
  DEFAULT_WALL_CLOCK_CAP_MS,
  noRetry,
  onErrorAgain,
  onProgress,
  pickDelay,
} from '../../../../src/core/recovery/index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classified(over: Partial<ClassifiedError> = {}): ClassifiedError {
  return { category: 'overload', transient: true, ...over }
}

function state(over: Partial<AttemptState> = {}): AttemptState {
  return { attemptsSinceProgress: 0, recoveryStartedAt: 0, ...over }
}

const NOW = 0

// ---------------------------------------------------------------------------
// backoffResume.decide — retry / give-up / fail branches
// ---------------------------------------------------------------------------

describe('backoffResume.decide', () => {
  it('returns retry with the default delay for an overload under the envelope', () => {
    const verdict = backoffResume().decide(classified(), state(), NOW)

    expect(verdict.kind).toBe('retry')
    if (verdict.kind === 'retry') expect(verdict.delayMs).toBe(DEFAULT_WAIT_MS)
  })

  it('gives up when attemptsSinceProgress reaches the ceiling exactly', () => {
    const verdict = backoffResume().decide(
      classified(),
      state({ attemptsSinceProgress: DEFAULT_CEILING }),
      NOW,
    )

    expect(verdict.kind).toBe('give-up')
    if (verdict.kind === 'give-up') expect(verdict.summary.reason).toBe('ceiling')
  })

  it('still retries one attempt below the ceiling', () => {
    const verdict = backoffResume().decide(
      classified(),
      state({ attemptsSinceProgress: DEFAULT_CEILING - 1 }),
      NOW,
    )

    expect(verdict.kind).toBe('retry')
  })

  it('gives up when wall-clock elapsed exceeds the cap even below the ceiling', () => {
    const start = 1000
    const now = start + DEFAULT_WALL_CLOCK_CAP_MS + 1

    const verdict = backoffResume().decide(
      classified(),
      state({ attemptsSinceProgress: 1, recoveryStartedAt: start }),
      now,
    )

    expect(verdict.kind).toBe('give-up')
    if (verdict.kind === 'give-up') {
      expect(verdict.summary.reason).toBe('wall-clock')
      expect(verdict.summary.elapsedMs).toBe(DEFAULT_WALL_CLOCK_CAP_MS + 1)
    }
  })

  it('treats a null recoveryStartedAt as zero elapsed so the cap is never tripped on entry', () => {
    const verdict = backoffResume().decide(
      classified(),
      state({ recoveryStartedAt: null }),
      999_999_999,
    )

    expect(verdict.kind).toBe('retry')
  })

  it('fails immediately on a usage_limit, carrying resetsAt and issuing no delay', () => {
    const resetsAt = 1_700_000_000_000

    const verdict = backoffResume().decide(
      classified({ category: 'usage_limit', transient: false, httpStatus: 429, resetsAt }),
      state(),
      NOW,
    )

    expect(verdict.kind).toBe('fail')
    if (verdict.kind === 'fail') expect(verdict.resetsAt).toBe(resetsAt)
  })

  it('fails on auth, invalid_request, and model_not_found without retrying', () => {
    const strategy = backoffResume()

    expect(
      strategy.decide(classified({ category: 'auth', transient: false }), state(), NOW).kind,
    ).toBe('fail')
    expect(
      strategy.decide(classified({ category: 'invalid_request', transient: false }), state(), NOW)
        .kind,
    ).toBe('fail')
    expect(
      strategy.decide(classified({ category: 'model_not_found', transient: false }), state(), NOW)
        .kind,
    ).toBe('fail')
  })

  it('retries an unknown/unclassifiable error within the envelope', () => {
    const verdict = backoffResume().decide(
      classified({ category: 'unknown', transient: true }),
      state(),
      NOW,
    )

    expect(verdict.kind).toBe('retry')
  })

  it('carries a configured ceiling override into the give-up boundary', () => {
    const strategy = backoffResume({ ceiling: 3 })

    expect(strategy.options?.ceiling).toBe(3)
    expect(strategy.decide(classified(), state({ attemptsSinceProgress: 3 }), NOW).kind).toBe(
      'give-up',
    )
    expect(strategy.decide(classified(), state({ attemptsSinceProgress: 2 }), NOW).kind).toBe(
      'retry',
    )
  })
})

// ---------------------------------------------------------------------------
// progress resets the counter (R9) — ceiling never trips while progress flows
// ---------------------------------------------------------------------------

describe('progress reset interplay (R9/R10)', () => {
  it('never gives up on the ceiling while progress keeps resetting the counter', () => {
    const strategy = backoffResume()
    let s = state({ recoveryStartedAt: 0 })

    // Ten rounds of error-then-progress: the counter resets to 0 each time, so
    // the ceiling (5) is never reached even though there were 10 errors.
    for (let round = 0; round < 10; round++) {
      s = onErrorAgain(s)
      const verdict = strategy.decide(classified(), s, NOW)
      expect(verdict.kind).toBe('retry')
      s = onProgress(s)
    }

    expect(s.attemptsSinceProgress).toBe(0)
  })

  it('gives up on the wall-clock cap even while progress keeps resetting the ceiling', () => {
    const strategy = backoffResume()
    let s = state({ recoveryStartedAt: 0 })

    s = onErrorAgain(s)
    const verdict = strategy.decide(classified(), s, DEFAULT_WALL_CLOCK_CAP_MS + 1)

    expect(verdict.kind).toBe('give-up')
    if (verdict.kind === 'give-up') expect(verdict.summary.reason).toBe('wall-clock')
  })
})

// ---------------------------------------------------------------------------
// noRetry — preserves today's fail-fast behavior
// ---------------------------------------------------------------------------

describe('noRetry.decide', () => {
  it('fails fast on an overload (today behavior preserved)', () => {
    const verdict = noRetry().decide(classified(), state(), NOW)

    expect(verdict.kind).toBe('fail')
  })

  it('carries resetsAt through on a usage_limit', () => {
    const resetsAt = 42

    const verdict = noRetry().decide(
      classified({ category: 'usage_limit', transient: false, resetsAt }),
      state(),
      NOW,
    )

    expect(verdict.kind).toBe('fail')
    if (verdict.kind === 'fail') expect(verdict.resetsAt).toBe(resetsAt)
  })

  it('exposes no resolved options', () => {
    expect(noRetry().options).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// pickDelay (R13)
// ---------------------------------------------------------------------------

describe('pickDelay', () => {
  const flat = { ceiling: 5, wallClockCapMs: 1, waits: {}, curve: 'flat' as const }

  it('honors a present serverRetryAfterMs over the configured per-class wait', () => {
    const delay = pickDelay(classified({ serverRetryAfterMs: 1234 }), 0, {
      ...flat,
      waits: { overload: 99_999 },
    })

    expect(delay).toBe(1234)
  })

  it('falls back to the per-class wait when no server hint is present', () => {
    const delay = pickDelay(classified(), 0, { ...flat, waits: { overload: 7000 } })

    expect(delay).toBe(7000)
  })

  it('falls back to the default wait when the category has no configured override', () => {
    const delay = pickDelay(classified(), 0, flat)

    expect(delay).toBe(DEFAULT_WAIT_MS)
  })

  it('doubles the base wait per attempt under the exponential curve', () => {
    const opts = { ...flat, waits: { overload: 1000 }, curve: 'exponential' as const }

    expect(pickDelay(classified(), 0, opts)).toBe(1000)
    expect(pickDelay(classified(), 1, opts)).toBe(2000)
    expect(pickDelay(classified(), 3, opts)).toBe(8000)
  })

  it('lets the server hint short-circuit the exponential curve', () => {
    const opts = { ...flat, waits: { overload: 1000 }, curve: 'exponential' as const }

    expect(pickDelay(classified({ serverRetryAfterMs: 50 }), 3, opts)).toBe(50)
  })
})
