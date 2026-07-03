// ---------------------------------------------------------------------------
// ClassifiedError — the normalized error a runner's `classifyError` produces.
//
// The recovery strategy is detection-mechanism-agnostic (R3): it never reads a
// runner's raw event stream. A runner adapter normalizes its CLI-specific
// signal (Claude's `api_error_status`, Codex's exit-1 + `turn.failed`) into one
// `ClassifiedError`, and the strategy decides purely from that.
//
// Classification keys off the numeric HTTP status first; the string label is an
// untrusted tiebreaker (R12, Key Technical Decisions). The captured 529 repro
// was labeled `rate_limit` / `server_error` / `subtype:"success"` in a single
// stream — the status is the only trustworthy signal.
// ---------------------------------------------------------------------------

/**
 * The error class a `ClassifiedError` carries. The retry classes
 * (`overload | server_error | unknown`) recover within the give-up envelope;
 * the rest are fail-fast (see {@link FAIL_FAST_CATEGORIES}).
 */
export type ErrorCategory =
  | 'overload' // 529 / 503 — provider overloaded, retry
  | 'server_error' // 500 / other 5xx — retry
  | 'rate_limit' // 429 without reset info — fail fast, surface
  | 'usage_limit' // 429 with reset info — fail fast, surface resetsAt
  | 'auth' // 401 / 403 — fail fast
  | 'billing' // fail fast
  | 'invalid_request' // fail fast
  | 'model_not_found' // fail fast
  | 'launch' // CLI died at startup before any stdout (bad config / missing binary) — fail fast
  | 'unknown' // unclassifiable — retry within the envelope

/**
 * One classified error. `transient` mirrors the category's retry posture
 * (derivable via {@link isFailFast}) but is carried explicitly so a runner can
 * record what it observed. `httpStatus` is the numeric status the
 * classification keyed off, when one was present. `serverRetryAfterMs` is a
 * server-supplied wait hint consumed internally by `pickDelay` only — it is
 * never forwarded into persisted recovery artifacts (see U8 data-handling).
 * `resetsAt` is an epoch-ms reset time surfaced for the fail-fast usage/rate
 * classes.
 */
export interface ClassifiedError {
  readonly category: ErrorCategory
  readonly transient: boolean
  readonly httpStatus?: number
  readonly serverRetryAfterMs?: number
  readonly resetsAt?: number
}

/**
 * Categories that stop recovery immediately rather than retrying. Single source
 * of truth for R12's fail-fast policy. Everything not in this set
 * (`overload | server_error | unknown`) is retryable within the envelope.
 */
export const FAIL_FAST_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'auth',
  'billing',
  'invalid_request',
  'model_not_found',
  'launch',
  'rate_limit',
  'usage_limit',
])

/** True when the category must fail fast (no retry). */
export function isFailFast(category: ErrorCategory): boolean {
  return FAIL_FAST_CATEGORIES.has(category)
}

/** True when the category is retryable within the give-up envelope. */
export function isTransientCategory(category: ErrorCategory): boolean {
  return !isFailFast(category)
}

/**
 * Map a numeric HTTP status to an {@link ErrorCategory} (R12). Keys off the
 * status alone — a 429 maps to the base `rate_limit`; a runner refines it to
 * `usage_limit` when it also sees reset info. Anything that is not a recognized
 * client/auth/overload status and not a 5xx falls through to `unknown` (which
 * is retryable), so an unexpected status never silently becomes fail-fast.
 */
export function categoryForStatus(status: number): ErrorCategory {
  if (status === 529 || status === 503) return 'overload'
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'unknown'
}

/**
 * True for the structural shape of a CLI that died at startup before doing any
 * work: a non-zero exit, **no** parsed stdout info events, and a non-empty
 * stderr tail. A genuine retryable API failure reports its status/keywords on
 * stdout (caught earlier) and emits info events along the way, so this predicate
 * only matches a launch/config crash — it must be consulted at a classifier's
 * `unknown` fallthrough, after the status/keyword checks, never before.
 *
 * Wording-independent on purpose: it keys off the no-output shape, not the
 * stderr phrasing, so it survives a CLI changing its error text.
 */
export function isLaunchFailureSignal(signal: {
  readonly exitCode: number
  readonly infoEvents: readonly unknown[]
  readonly stderr: string
}): boolean {
  return signal.exitCode !== 0 && signal.infoEvents.length === 0 && signal.stderr.trim().length > 0
}
