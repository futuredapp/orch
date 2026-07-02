// ---------------------------------------------------------------------------
// runRecoveryLoop — the I/O realization of the backoffResume verdict (F1, U7).
//
// The pure verdict lives in `strategy.ts`; this is the loop that drives it:
// classify → decide → `clock.sleep` → run a forked attempt under a stall
// watchdog → reset on progress / re-classify on another error. It owns no
// subprocess or fs I/O directly — the caller injects `runAttempt`, which builds
// the fork command (Claude `--fork-session` / Codex rollout-copy / resume-in-
// place fallback) and runs it with its own raw-capture + spawn span. The loop
// only sequences attempts, applies the verdict, and accumulates the recovery
// log; it returns a discriminated result rather than throwing, so the executor
// owns persistence + the legible `StepError` (R15, R16).
//
// Checkpoint does NOT advance mid-recovery (U7 decision): every attempt forks
// from the original pre-recovery `checkpointSessionId`; progress only resets the
// attempt counter (R8, R9).
// ---------------------------------------------------------------------------

import type { ClassifyErrorSignal, InfoEvent, TerminalEvent } from '../../runners/types.ts'
import type { Clock } from '../../services/index.ts'
import type { ClassifiedError, ErrorCategory } from './classified-error.ts'
import { DEFAULT_STALL_TIMEOUT_MS, type GiveUpSummary, type RecoveryStrategy } from './strategy.ts'

// ---------------------------------------------------------------------------
// Recovery log (R16) — one entry per fork attempt; persisted on `StepEntry`.
// The persisted shape is mirrored structurally in `src/state/state-store.ts`
// (`PersistedRecoveryLogEntry`) so `src/state` stays free of a `src/core`
// dependency, matching the `PersistedWorkflowArgs` convention.
// ---------------------------------------------------------------------------

/** Per-attempt outcome. Forward-tolerant at the persistence boundary (U8): a
 *  Phase-2-written value must not reject a Phase-1 state-file load. */
export type RecoveryOutcome = 'progressed' | 'errored-again' | 'gave-up' | 'completed'

export interface RecoveryLogEntry {
  /** 1-based index of the fork attempt; the `gave-up` marker carries the next index. */
  readonly attemptIndex: number
  /** The classified category that drove this attempt's decision. */
  readonly errorClass: ErrorCategory
  /** The wait honored before this attempt (0 for the `gave-up` marker). */
  readonly waitMs: number
  /** The clean checkpoint this attempt forked from (R8 — constant across attempts). */
  readonly parentSessionId: string
  /** The forked session id captured from this attempt's `session-started`, when seen. */
  readonly forkSessionId?: string
  readonly outcome: RecoveryOutcome
}

// ---------------------------------------------------------------------------
// Attempt seam — what the caller hands back for each run (initial + forks)
// ---------------------------------------------------------------------------

/** The minimal `RunnerResult` shape the loop reads — avoids importing the
 *  runner executor into core just for the terminal event + exit code. */
export interface AttemptRunResult {
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  /** Bounded stderr tail, forwarded into the classify signal. Optional here so
   *  scripted test attempts need not set it; the executor always provides it. */
  readonly stderr?: string
}

/**
 * The normalized outcome of one runner invocation. The caller's `runAttempt`
 * (and the executor's initial pre-recovery run) produces this: the terminal
 * result, whether real progress fired on this attempt (`isProgressEvent`), the
 * accumulated info events for re-classification, and the forked session id read
 * from this attempt's `session-started` event.
 */
export interface AttemptOutcome {
  readonly result: AttemptRunResult
  readonly sawProgress: boolean
  readonly infoEvents: readonly InfoEvent[]
  readonly forkSessionId?: string
}

// ---------------------------------------------------------------------------
// Loop result — discriminated, never throws for control flow
// ---------------------------------------------------------------------------

export type RecoveryFailure =
  | { readonly kind: 'fail'; readonly category: ErrorCategory; readonly resetsAt?: number }
  | { readonly kind: 'give-up'; readonly summary: GiveUpSummary }

export type RecoveryLoopResult =
  | {
      readonly ok: true
      /** The successful (turn-complete) attempt's result, for output extraction. */
      readonly result: AttemptRunResult
      readonly recoveryLog: readonly RecoveryLogEntry[]
      /** The last successful fork's id — the step's resumable checkpoint (R8/U8). */
      readonly forkSessionId?: string
    }
  | {
      readonly ok: false
      readonly recoveryLog: readonly RecoveryLogEntry[]
      readonly failure: RecoveryFailure
    }

export interface RecoveryLoopDeps {
  /** Must be a `backoffResume` strategy (carries `options`). */
  readonly strategy: RecoveryStrategy
  readonly clock: Clock
  /** The clean pre-recovery checkpoint every attempt forks from (R8). */
  readonly checkpointSessionId: string
  /** Normalize a terminal signal into a {@link ClassifiedError} (the runner's port). */
  readonly classify: (signal: ClassifyErrorSignal) => ClassifiedError
  /** The pre-recovery attempt — the error that triggered recovery. */
  readonly initial: AttemptOutcome
  /**
   * Run one forked attempt under the loop's stall watchdog. The caller builds
   * the fork (or resume-in-place) command and runs it, wiring `signal` into both
   * the fork primitive and `runRunner` so the watchdog can abort a hung attempt.
   */
  readonly runAttempt: (signal: AbortSignal) => Promise<AttemptOutcome>
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

// Over the cognitive-complexity budget (CLAUDE.md rule #5): this is one verdict
// state machine — the verdict's three outcomes (fail / give-up / retry) and the
// retried attempt's three results (completed / progressed / errored-again) are
// the irreducible branch set. Splitting it would scatter the single loop the
// sequence diagram documents; the pure verdict already lives in `strategy.ts`.
export async function runRecoveryLoop(deps: RecoveryLoopDeps): Promise<RecoveryLoopResult> {
  const { strategy, clock, checkpointSessionId, classify, initial, runAttempt } = deps
  const stallTimeoutMs = strategy.options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  let classified = classify(toSignal(initial))
  let attemptsSinceProgress = 0
  let recoveryStartedAt: number | null = null
  let attemptIndex = 0
  const log: RecoveryLogEntry[] = []

  for (;;) {
    const verdict = strategy.decide(
      classified,
      { attemptsSinceProgress, recoveryStartedAt },
      clock.now(),
    )

    if (verdict.kind === 'fail') {
      return {
        ok: false,
        recoveryLog: log,
        failure: {
          kind: 'fail',
          category: classified.category,
          ...(verdict.resetsAt !== undefined ? { resetsAt: verdict.resetsAt } : {}),
        },
      }
    }

    if (verdict.kind === 'give-up') {
      log.push({
        attemptIndex: attemptIndex + 1,
        errorClass: verdict.summary.category,
        waitMs: 0,
        parentSessionId: checkpointSessionId,
        outcome: 'gave-up',
      })
      return { ok: false, recoveryLog: log, failure: { kind: 'give-up', summary: verdict.summary } }
    }

    // retry
    if (recoveryStartedAt === null) recoveryStartedAt = clock.now()
    await clock.sleep(verdict.delayMs)
    attemptIndex += 1

    const { outcome: attempt, timedOut } = await runUnderWatchdog(clock, stallTimeoutMs, runAttempt)
    const succeeded =
      !timedOut &&
      attempt.result.finalEvent.type === 'turn-complete' &&
      attempt.result.exitCode === 0

    if (succeeded) {
      log.push({
        attemptIndex,
        errorClass: classified.category,
        waitMs: verdict.delayMs,
        parentSessionId: checkpointSessionId,
        ...(attempt.forkSessionId !== undefined ? { forkSessionId: attempt.forkSessionId } : {}),
        outcome: 'completed',
      })
      return {
        ok: true,
        result: attempt.result,
        recoveryLog: log,
        ...(attempt.forkSessionId !== undefined ? { forkSessionId: attempt.forkSessionId } : {}),
      }
    }

    // A stalled (watchdog-aborted) attempt counts as non-progress even if it
    // emitted one event before hanging — a hang is not productive progress, and
    // treating it as progress would reset the counter forever (R10).
    const progressed = attempt.sawProgress && !timedOut
    log.push({
      attemptIndex,
      errorClass: classified.category,
      waitMs: verdict.delayMs,
      parentSessionId: checkpointSessionId,
      ...(attempt.forkSessionId !== undefined ? { forkSessionId: attempt.forkSessionId } : {}),
      outcome: progressed ? 'progressed' : 'errored-again',
    })
    attemptsSinceProgress = progressed ? 0 : attemptsSinceProgress + 1
    classified = classify(toSignal(attempt))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSignal(outcome: AttemptOutcome): ClassifyErrorSignal {
  return {
    finalEvent: outcome.result.finalEvent,
    exitCode: outcome.result.exitCode,
    infoEvents: outcome.infoEvents,
    stderr: outcome.result.stderr ?? '',
  }
}

/**
 * Run one attempt racing a clock-driven stall watchdog. On timeout the attempt's
 * `AbortSignal` fires (killing the spawn so `runRunner` unwinds), and we report
 * `timedOut: true`. When the attempt wins, the watchdog's own signal is aborted
 * so the underlying timer is cleared (`BunClock` `clearTimeout`) — otherwise a
 * fast recovery would leave a long timer pending and hold the process alive.
 */
async function runUnderWatchdog(
  clock: Clock,
  stallTimeoutMs: number,
  runAttempt: (signal: AbortSignal) => Promise<AttemptOutcome>,
): Promise<{ outcome: AttemptOutcome; timedOut: boolean }> {
  const attemptAbort = new AbortController()
  const watchdogAbort = new AbortController()
  let timedOut = false
  void clock.sleep(stallTimeoutMs, watchdogAbort.signal).then(() => {
    // Distinguish a real timeout from cancellation: when the attempt finished
    // first we aborted the watchdog, which also resolves the sleep.
    if (watchdogAbort.signal.aborted) return
    timedOut = true
    attemptAbort.abort()
  })
  try {
    const outcome = await runAttempt(attemptAbort.signal)
    return { outcome, timedOut }
  } finally {
    watchdogAbort.abort()
  }
}

// ---------------------------------------------------------------------------
// Legible failure message (R15)
// ---------------------------------------------------------------------------

/** Compose the human-facing `StepError` message for a recovery failure (R15).
 *  States how many times the step recovered, the error class, and total time. */
export function formatRecoveryFailure(
  failure: RecoveryFailure,
  recoveryLog: readonly RecoveryLogEntry[],
): string {
  if (failure.kind === 'fail') {
    const reset =
      failure.resetsAt !== undefined
        ? `; resets at ${new Date(failure.resetsAt).toISOString()}`
        : ''
    return `recovery declined — ${failure.category} is not retryable${reset}`
  }
  const { summary } = failure
  const attempts = recoveryLog.filter((e) => e.outcome !== 'gave-up').length
  const progressed = recoveryLog.filter((e) => e.outcome === 'progressed').length
  const reason =
    summary.reason === 'ceiling'
      ? `${summary.attempts} attempts without progress`
      : 'wall-clock cap'
  return (
    `recovered across ${attempts} attempt(s) (${progressed} with progress) over ` +
    `${formatDuration(summary.elapsedMs)}, then gave up: ${summary.category} (${reason})`
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}
