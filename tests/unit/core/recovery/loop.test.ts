import { describe, expect, it } from 'bun:test'
import type {
  AttemptOutcome,
  ClassifiedError,
  ErrorCategory,
  RecoveryLoopResult,
} from '../../../../src/core/recovery/index.ts'
import {
  backoffResume,
  formatRecoveryFailure,
  noRetry,
  runRecoveryLoop,
} from '../../../../src/core/recovery/index.ts'
import type { ClassifyErrorSignal, TerminalEvent } from '../../../../src/runners/index.ts'
import { FakeClock } from '../../../../src/services/index.ts'

// ---------------------------------------------------------------------------
// Helpers — scripted attempts + a fake-clock driver
// ---------------------------------------------------------------------------

const RETRYABLE: ReadonlySet<ErrorCategory> = new Set(['overload', 'server_error', 'unknown'])

/** Classify off the terminal error message naming a category (test control). */
function classify(signal: ClassifyErrorSignal): ClassifiedError {
  const msg = signal.finalEvent.type === 'error' ? signal.finalEvent.message : ''
  const known: readonly ErrorCategory[] = [
    'auth',
    'usage_limit',
    'rate_limit',
    'server_error',
    'overload',
    'unknown',
  ]
  const category = known.find((c) => msg.includes(c)) ?? 'overload'
  return { category, transient: RETRYABLE.has(category) }
}

function errored(
  message: string,
  opts: { sawProgress?: boolean; forkSessionId?: string } = {},
): AttemptOutcome {
  const finalEvent: TerminalEvent = { kind: 'terminal', type: 'error', message }
  return {
    result: { finalEvent, exitCode: 1 },
    sawProgress: opts.sawProgress ?? false,
    infoEvents: [],
    ...(opts.forkSessionId !== undefined ? { forkSessionId: opts.forkSessionId } : {}),
  }
}

function completed(forkSessionId?: string): AttemptOutcome {
  const finalEvent: TerminalEvent = { kind: 'terminal', type: 'turn-complete', data: { ok: true } }
  return {
    result: { finalEvent, exitCode: 0 },
    sawProgress: true,
    infoEvents: [],
    ...(forkSessionId !== undefined ? { forkSessionId } : {}),
  }
}

/** A `runAttempt` that returns the next scripted outcome in order. */
function scripted(outcomes: readonly AttemptOutcome[]): {
  runAttempt: (signal: AbortSignal) => Promise<AttemptOutcome>
  calls: () => number
} {
  let i = 0
  return {
    runAttempt: async () => {
      const next = outcomes[i++]
      if (next === undefined) throw new Error(`scripted: no attempt #${i}`)
      return next
    },
    calls: () => i,
  }
}

/** Advance a FakeClock in fixed steps until the loop settles. Each tick yields
 *  the microtask queue (so a pending `clock.sleep` is registered) before
 *  advancing, matching the codex capture-test `setImmediate` barrier. */
async function drive(
  promise: Promise<RecoveryLoopResult>,
  clock: FakeClock,
  stepMs: number,
): Promise<RecoveryLoopResult> {
  let settled = false
  let value: RecoveryLoopResult | undefined
  void promise.then((v) => {
    settled = true
    value = v
  })
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setImmediate(r))
    if (settled) return value as RecoveryLoopResult
    clock.advance(stepMs)
  }
  throw new Error('recovery loop did not settle')
}

const WAIT = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Happy path — recover then complete (AE1)
// ---------------------------------------------------------------------------

describe('runRecoveryLoop success paths', () => {
  it('forks once, completes, and records a single completed entry with the fork id', async () => {
    const clock = new FakeClock()
    const { runAttempt, calls } = scripted([completed('fork-1')])

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(calls()).toBe(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.forkSessionId).toBe('fork-1')
      expect(result.recoveryLog).toHaveLength(1)
      expect(result.recoveryLog[0]).toMatchObject({
        attemptIndex: 1,
        outcome: 'completed',
        parentSessionId: 'checkpoint-0',
        forkSessionId: 'fork-1',
      })
    }
  })

  it('every attempt forks from the original checkpoint, never the polluted tip (R8)', async () => {
    const clock = new FakeClock()
    // Two progress-then-die attempts, then a completing one.
    const { runAttempt } = scripted([
      errored('overload', { sawProgress: true, forkSessionId: 'fork-1' }),
      errored('overload', { sawProgress: true, forkSessionId: 'fork-2' }),
      completed('fork-3'),
    ])

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.recoveryLog.map((e) => e.parentSessionId)).toEqual([
        'checkpoint-0',
        'checkpoint-0',
        'checkpoint-0',
      ])
      expect(result.recoveryLog.map((e) => e.outcome)).toEqual([
        'progressed',
        'progressed',
        'completed',
      ])
    }
  })
})

// ---------------------------------------------------------------------------
// Give-up — ceiling and wall-clock (AE2, AE3)
// ---------------------------------------------------------------------------

describe('runRecoveryLoop give-up paths', () => {
  it('gives up on the 5th no-progress attempt and runs no 6th (AE2/R10)', async () => {
    const clock = new FakeClock()
    const { runAttempt, calls } = scripted(Array.from({ length: 5 }, () => errored('overload')))

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(calls()).toBe(5)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('give-up')
      if (result.failure.kind === 'give-up') expect(result.failure.summary.reason).toBe('ceiling')
      // 5 errored-again entries + 1 gave-up marker.
      expect(result.recoveryLog.map((e) => e.outcome)).toEqual([
        'errored-again',
        'errored-again',
        'errored-again',
        'errored-again',
        'errored-again',
        'gave-up',
      ])
    }
  })

  it('gives up on the wall-clock cap while progress keeps resetting the ceiling (AE3/AE4)', async () => {
    const clock = new FakeClock()
    // Every attempt progresses then dies, so the ceiling never trips; only the
    // wall-clock cap (advanced by the driver) ends it.
    const { runAttempt } = scripted(
      Array.from({ length: 50 }, (_, i) =>
        errored('overload', { sawProgress: true, forkSessionId: `f${i}` }),
      ),
    )

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume({ wallClockCapMs: 30 * 60 * 1000 }),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(result.ok).toBe(false)
    if (!result.ok && result.failure.kind === 'give-up') {
      expect(result.failure.summary.reason).toBe('wall-clock')
    }
  })
})

// ---------------------------------------------------------------------------
// Fail-fast (R12)
// ---------------------------------------------------------------------------

describe('runRecoveryLoop fail-fast', () => {
  it('declines immediately on auth with no attempts and logs a single failed-fast entry naming the class', async () => {
    const clock = new FakeClock()
    const { runAttempt, calls } = scripted([])

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('auth'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(calls()).toBe(0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('fail')
      expect(result.recoveryLog).toHaveLength(1)
      expect(result.recoveryLog[0]).toMatchObject({
        errorClass: 'auth',
        outcome: 'failed-fast',
        parentSessionId: 'checkpoint-0',
        waitMs: 0,
      })
    }
  })

  it('declines mid-recovery when a later attempt returns a fail-fast class, keeping prior entries', async () => {
    const clock = new FakeClock()
    const { runAttempt } = scripted([errored('overload'), errored('auth')])

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('fail')
      if (result.failure.kind === 'fail') expect(result.failure.category).toBe('auth')
      // Both overload attempts errored-again; the auth re-classification then
      // fails fast, appending a failed-fast entry that names the class.
      expect(result.recoveryLog.map((e) => e.outcome)).toEqual([
        'errored-again',
        'errored-again',
        'failed-fast',
      ])
      expect(result.recoveryLog.at(-1)).toMatchObject({
        errorClass: 'auth',
        outcome: 'failed-fast',
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Launch failure — a startup crash fails fast with no backoff (issue 2026-06-23)
// ---------------------------------------------------------------------------

/** Wraps a FakeClock to count `sleep` calls — proves a fail-fast path never
 *  enters the backoff. */
class CountingClock {
  sleeps = 0
  readonly #inner = new FakeClock()
  now(): number {
    return this.#inner.now()
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps += 1
    return this.#inner.sleep(ms, signal)
  }
}

describe('runRecoveryLoop launch fail-fast', () => {
  it('returns fail without forking or sleeping when the initial error is non-transient', async () => {
    const clock = new CountingClock()
    const { runAttempt, calls } = scripted([])
    // A startup crash: stderr-bearing, no info events, non-zero exit.
    const launchCrash: AttemptOutcome = {
      result: {
        finalEvent: { kind: 'terminal', type: 'error', message: 'produced no terminal event' },
        exitCode: 1,
        stderr: 'Error loading rules: invalid decision: deny',
      },
      sawProgress: false,
      infoEvents: [],
    }

    const result = await runRecoveryLoop({
      strategy: backoffResume(),
      clock,
      checkpointSessionId: 'checkpoint-0',
      // Classify off the forwarded stderr — proves toSignal threads it through.
      classify: (signal) =>
        signal.stderr.includes('Error loading rules')
          ? { category: 'launch', transient: false }
          : { category: 'unknown', transient: true },
      initial: launchCrash,
      runAttempt,
    })

    expect(clock.sleeps).toBe(0)
    expect(calls()).toBe(0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('fail')
      if (result.failure.kind === 'fail') expect(result.failure.category).toBe('launch')
      expect(result.recoveryLog).toHaveLength(1)
      expect(result.recoveryLog[0]).toMatchObject({ errorClass: 'launch', outcome: 'failed-fast' })
    }
  })
})

// ---------------------------------------------------------------------------
// Stall watchdog (R10 — never hold open indefinitely)
// ---------------------------------------------------------------------------

describe('runRecoveryLoop stall watchdog', () => {
  it('aborts an attempt that emits progress then hangs, counting it as non-progress so the ceiling trips', async () => {
    const clock = new FakeClock()
    let aborts = 0
    // The attempt resolves only when its watchdog signal aborts — simulating a
    // fork that emits one event then wedges with stdout open.
    const runAttempt = (signal: AbortSignal): Promise<AttemptOutcome> =>
      new Promise<AttemptOutcome>((resolve) => {
        const finish = (): void => {
          aborts++
          resolve(errored('overload', { sawProgress: true }))
        }
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      })

    const result = await drive(
      runRecoveryLoop({
        strategy: backoffResume({ stallTimeoutMs: WAIT }),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(aborts).toBe(5)
    expect(result.ok).toBe(false)
    if (!result.ok && result.failure.kind === 'give-up') {
      expect(result.failure.summary.reason).toBe('ceiling')
    }
  })
})

// ---------------------------------------------------------------------------
// Legible message (R15)
// ---------------------------------------------------------------------------

describe('formatRecoveryFailure', () => {
  it('states attempts, progress count, total time, class, and reason on give-up', () => {
    const message = formatRecoveryFailure(
      {
        kind: 'give-up',
        summary: { attempts: 5, elapsedMs: 90_000, category: 'overload', reason: 'ceiling' },
      },
      [
        {
          attemptIndex: 1,
          errorClass: 'overload',
          waitMs: WAIT,
          parentSessionId: 'c',
          outcome: 'progressed',
        },
        {
          attemptIndex: 2,
          errorClass: 'overload',
          waitMs: WAIT,
          parentSessionId: 'c',
          outcome: 'errored-again',
        },
        {
          attemptIndex: 3,
          errorClass: 'overload',
          waitMs: 0,
          parentSessionId: 'c',
          outcome: 'gave-up',
        },
      ],
    )

    expect(message).toContain('2 attempt(s)')
    expect(message).toContain('1 with progress')
    expect(message).toContain('1m 30s')
    expect(message).toContain('overload')
  })

  it('names the non-retryable class on a fail-fast decline', () => {
    const message = formatRecoveryFailure({ kind: 'fail', category: 'auth' }, [])

    expect(message).toContain('auth')
    expect(message).toContain('not retryable')
  })
})

// ---------------------------------------------------------------------------
// noRetry never enters the loop — guard documented at the call site, but the
// strategy still declines if it ever did (defensive).
// ---------------------------------------------------------------------------

describe('noRetry strategy through the loop', () => {
  it('declines on the first error without forking', async () => {
    const clock = new FakeClock()
    const { runAttempt, calls } = scripted([])

    const result = await drive(
      runRecoveryLoop({
        strategy: noRetry(),
        clock,
        checkpointSessionId: 'checkpoint-0',
        classify,
        initial: errored('overload'),
        runAttempt,
      }),
      clock,
      WAIT,
    )

    expect(calls()).toBe(0)
    expect(result.ok).toBe(false)
  })
})
