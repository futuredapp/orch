// ---------------------------------------------------------------------------
// RecoveryStrategy — the pluggable verdict object (R1, R2).
//
// The executor invokes a strategy at the agent-step error site and applies its
// verdict; core never hard-codes retry logic. Two strategies ship: `noRetry`
// (today's fail-fast) and `backoffResume` (the recovery loop, F1). The verdict
// function is PURE and fake-clock-testable: `now` is passed in, never read from
// a global, and thresholds come from the strategy's resolved options (R17).
//
// The checkpoint does NOT advance mid-recovery (U7 decision): `onProgress` only
// resets the attempt counter; the I/O loop (U7) keeps forking from the original
// pre-recovery checkpoint. So `AttemptState` carries no checkpoint here.
// ---------------------------------------------------------------------------

import { type ClassifiedError, type ErrorCategory, isFailFast } from './classified-error.ts'

// ---------------------------------------------------------------------------
// Defaults (R10, R13)
// ---------------------------------------------------------------------------

/** Default attempts-since-progress ceiling before give-up (R10). */
export const DEFAULT_CEILING = 5
/** Default total recovery wall-clock cap: 60 minutes (R10). */
export const DEFAULT_WALL_CLOCK_CAP_MS = 60 * 60 * 1000
/** Default per-class wait between attempts: ~5 minutes (R13). */
export const DEFAULT_WAIT_MS = 5 * 60 * 1000
/**
 * Default per-attempt stall watchdog (U7). A single forked attempt may not run
 * longer than this before the loop aborts it and re-enters the verdict — so a
 * fork that emits one event then hangs (stdout never closes) can never hold the
 * run open indefinitely. Defaults to the wall-clock cap, so the out-of-the-box
 * behavior is "one attempt is bounded by the whole envelope" (no premature
 * kills of a legitimately long turn); tune it down to fail a hung attempt sooner.
 */
export const DEFAULT_STALL_TIMEOUT_MS = DEFAULT_WALL_CLOCK_CAP_MS

/** Wait-curve shape between attempts. `flat` is the default per R13. */
export type WaitCurve = 'flat' | 'exponential'

// ---------------------------------------------------------------------------
// Options + resolved options
// ---------------------------------------------------------------------------

export interface BackoffResumeOptions {
  /** Attempts since the last progress event before giving up (default 5). */
  readonly ceiling?: number
  /** Total recovery wall-clock cap in ms (default 60 min). */
  readonly wallClockCapMs?: number
  /** Per-category wait override in ms; unset categories use {@link DEFAULT_WAIT_MS}. */
  readonly waits?: Partial<Record<ErrorCategory, number>>
  /** Wait curve between attempts (default `flat`). */
  readonly curve?: WaitCurve
  /**
   * Per-attempt stall watchdog in ms (default {@link DEFAULT_STALL_TIMEOUT_MS}).
   * The loop aborts a forked attempt that runs longer than this and re-enters
   * the verdict, so a hung CLI cannot hold the run open indefinitely (U7).
   */
  readonly stallTimeoutMs?: number
}

/** Options with every default applied — what a `backoffResume` strategy carries. */
export interface ResolvedBackoffOptions {
  readonly ceiling: number
  readonly wallClockCapMs: number
  readonly waits: Partial<Record<ErrorCategory, number>>
  readonly curve: WaitCurve
  readonly stallTimeoutMs: number
}

function resolveOptions(opts: BackoffResumeOptions): ResolvedBackoffOptions {
  // A ceiling below 1 makes the first verdict give up before any fork (0 >= 0),
  // silently turning recovery into a no-op. That intent is `noRetry()`, not a
  // zero ceiling — fail loudly at construction instead.
  if (opts.ceiling !== undefined && opts.ceiling < 1) {
    throw new Error('backoffResume: `ceiling` must be >= 1 (use noRetry() to disable recovery)')
  }
  return {
    ceiling: opts.ceiling ?? DEFAULT_CEILING,
    wallClockCapMs: opts.wallClockCapMs ?? DEFAULT_WALL_CLOCK_CAP_MS,
    waits: opts.waits ?? {},
    curve: opts.curve ?? 'flat',
    stallTimeoutMs: opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// Attempt state + verdict
// ---------------------------------------------------------------------------

export interface AttemptState {
  /** Failed attempts since the last confirmed progress event (R9, R10). */
  readonly attemptsSinceProgress: number
  /**
   * Epoch ms when recovery for this step began, or `null` before the first
   * verdict. `null` is treated as zero elapsed (the first decision), so the
   * wall-clock cap is never tripped on entry.
   */
  readonly recoveryStartedAt: number | null
}

/** Why a `give-up` verdict was reached — drives the legible message (U8/R15). */
export interface GiveUpSummary {
  readonly attempts: number
  readonly elapsedMs: number
  readonly category: ErrorCategory
  readonly reason: 'ceiling' | 'wall-clock'
}

export type Verdict =
  | { readonly kind: 'fail'; readonly resetsAt?: number }
  | { readonly kind: 'give-up'; readonly summary: GiveUpSummary }
  | { readonly kind: 'retry'; readonly delayMs: number }

// ---------------------------------------------------------------------------
// RecoveryStrategy — the port the executor invokes
// ---------------------------------------------------------------------------

export interface RecoveryStrategy {
  readonly kind: 'noRetry' | 'backoffResume'
  /**
   * The pure verdict. `now` is injected (never read from a global) so the loop
   * can drive it with a `FakeClock`. Returns `fail` for a fail-fast class,
   * `give-up` when the envelope is exhausted, otherwise `retry` with a delay.
   */
  decide(classified: ClassifiedError, state: AttemptState, now: number): Verdict
  /** Resolved options — present on `backoffResume`, absent on `noRetry`. */
  readonly options?: ResolvedBackoffOptions
}

// ---------------------------------------------------------------------------
// pickDelay (R13)
// ---------------------------------------------------------------------------

/**
 * Choose the wait before the next attempt. A server-supplied
 * `serverRetryAfterMs` hint wins over the configured per-class wait (R13). The
 * `exponential` curve doubles the base per attempt-since-progress; the server
 * hint short-circuits the curve.
 */
export function pickDelay(
  classified: ClassifiedError,
  attemptsSinceProgress: number,
  opts: ResolvedBackoffOptions,
): number {
  if (classified.serverRetryAfterMs !== undefined) return classified.serverRetryAfterMs
  const base = opts.waits[classified.category] ?? DEFAULT_WAIT_MS
  if (opts.curve === 'exponential') return base * 2 ** attemptsSinceProgress
  return base
}

// ---------------------------------------------------------------------------
// State transitions (pure — the loop owns the state, U7)
// ---------------------------------------------------------------------------

/** Reset the attempt counter on a confirmed progress event (R9). The
 *  checkpoint is NOT advanced (U7 decision) — only the counter resets. */
export function onProgress(state: AttemptState): AttemptState {
  return { ...state, attemptsSinceProgress: 0 }
}

/** Increment the attempt counter after another terminal error (R10). */
export function onErrorAgain(state: AttemptState): AttemptState {
  return { ...state, attemptsSinceProgress: state.attemptsSinceProgress + 1 }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function failVerdict(classified: ClassifiedError): Verdict {
  return {
    kind: 'fail',
    ...(classified.resetsAt !== undefined ? { resetsAt: classified.resetsAt } : {}),
  }
}

/** Today's fail-fast behavior: any error fails the step immediately (R2). */
export function noRetry(): RecoveryStrategy {
  return {
    kind: 'noRetry',
    decide(classified: ClassifiedError): Verdict {
      return failVerdict(classified)
    },
  }
}

/**
 * Resolve the effective strategy for an autonomous agent step (R14). Precedence:
 * the step's own `recovery:` wins, then the workflow-level default, then the
 * built-in `backoffResume()`. Pure — the executor (U7) calls this at the error
 * site; kept off the public author barrel.
 */
export function resolveRecoveryStrategy(
  stepRecovery: RecoveryStrategy | undefined,
  workflowDefault: RecoveryStrategy | undefined,
): RecoveryStrategy {
  return stepRecovery ?? workflowDefault ?? backoffResume()
}

/** The recovery loop's strategy (F1): fail fast on terminal classes, give up
 *  when the envelope is exhausted, otherwise retry with a per-class wait. */
export function backoffResume(opts: BackoffResumeOptions = {}): RecoveryStrategy {
  const resolved = resolveOptions(opts)
  return {
    kind: 'backoffResume',
    options: resolved,
    decide(classified: ClassifiedError, state: AttemptState, now: number): Verdict {
      if (isFailFast(classified.category)) return failVerdict(classified)

      const elapsedMs = state.recoveryStartedAt === null ? 0 : now - state.recoveryStartedAt
      const hitCeiling = state.attemptsSinceProgress >= resolved.ceiling
      const hitWallClock = elapsedMs >= resolved.wallClockCapMs
      if (hitCeiling || hitWallClock) {
        return {
          kind: 'give-up',
          summary: {
            attempts: state.attemptsSinceProgress,
            elapsedMs,
            category: classified.category,
            reason: hitCeiling ? 'ceiling' : 'wall-clock',
          },
        }
      }

      return {
        kind: 'retry',
        delayMs: pickDelay(classified, state.attemptsSinceProgress, resolved),
      }
    },
  }
}
