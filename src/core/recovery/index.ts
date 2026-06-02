// Public barrel for the recovery module. Cross-module imports come through
// here, not from internal files (project rule #7).

export type { ClassifiedError, ErrorCategory } from './classified-error.ts'
export {
  categoryForStatus,
  FAIL_FAST_CATEGORIES,
  isFailFast,
  isTransientCategory,
} from './classified-error.ts'
export type {
  AttemptState,
  BackoffResumeOptions,
  GiveUpSummary,
  RecoveryStrategy,
  ResolvedBackoffOptions,
  Verdict,
  WaitCurve,
} from './strategy.ts'
export {
  backoffResume,
  DEFAULT_CEILING,
  DEFAULT_WAIT_MS,
  DEFAULT_WALL_CLOCK_CAP_MS,
  noRetry,
  onErrorAgain,
  onProgress,
  pickDelay,
  resolveRecoveryStrategy,
} from './strategy.ts'
