// ---------------------------------------------------------------------------
// Claude headless error classification (R5, R12).
//
// The recovery loop hands `classifyError` a `ClassifyErrorSignal` — the terminal
// event runRunner returned plus the attempt's accumulated info events. Claude
// surfaces the numeric HTTP status in two places, neither of which is the string
// label:
//
//   - the `result` envelope's `api_error_status` (a number, or `null` on success)
//     rides `finalEvent.data` via the schema passthrough; and
//   - each `api_retry` system event carries `error_status` (e.g. 529) in its
//     payload — informational while the CLI self-retries, but the trustworthy
//     status once the retries terminalize.
//
// We classify off that numeric status alone (R12): the captured 529 repro was
// labeled `rate_limit` / `server_error` / `subtype:"success"` across one stream,
// so the `error` string and `subtype` are untrusted. When no numeric status is
// recoverable (e.g. the stream ended with only the synthetic `isApiErrorMessage`
// assistant turn, or no terminal event at all), we fall back to `unknown` —
// retryable within the give-up envelope — so an unreadable failure never
// silently fails fast.
// ---------------------------------------------------------------------------

import {
  type ClassifiedError,
  categoryForStatus,
  isTransientCategory,
} from '../../core/recovery/index.ts'
import type { ClassifyErrorSignal, InfoEvent } from '../types.ts'

/** Read the numeric HTTP status from a Claude payload, tolerating the two field
 *  names Claude uses (`api_error_status` on the result envelope, `error_status`
 *  on `api_retry` events). `null`/non-number (the success case) yields
 *  `undefined`. */
function readStatus(obj: Readonly<Record<string, unknown>> | undefined): number | undefined {
  if (obj === undefined) return undefined
  for (const key of ['api_error_status', 'error_status'] as const) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** The reset epoch (ms) for a 429, when the payload carries one. Distinguishes
 *  `usage_limit` (has reset info) from a bare `rate_limit` (R12). Accepts the
 *  common field spellings; a seconds-looking value is scaled to ms. */
function readResetsAt(obj: Readonly<Record<string, unknown>> | undefined): number | undefined {
  if (obj === undefined) return undefined
  for (const key of ['resets_at', 'reset_at', 'retry_after_ms'] as const) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      // Heuristic: a value below ~10^11 is seconds-since-epoch, not ms.
      return value < 1e11 ? value * 1000 : value
    }
  }
  return undefined
}

/** Last-writer-wins scan of the terminal event's data then the attempt's info
 *  events (newest first) for the first readable numeric status + reset hint. */
function findStatusAndReset(signal: ClassifyErrorSignal): {
  status: number | undefined
  resetsAt: number | undefined
} {
  const terminalData =
    typeof signal.finalEvent.data === 'object' && signal.finalEvent.data !== null
      ? (signal.finalEvent.data as Readonly<Record<string, unknown>>)
      : undefined
  const fromTerminal = readStatus(terminalData)
  if (fromTerminal !== undefined) {
    return { status: fromTerminal, resetsAt: readResetsAt(terminalData) }
  }

  // Newest api_retry/error event wins — it reflects the final attempt.
  for (let i = signal.infoEvents.length - 1; i >= 0; i -= 1) {
    const payload = (signal.infoEvents[i] as InfoEvent | undefined)?.payload
    const status = readStatus(payload)
    if (status !== undefined) return { status, resetsAt: readResetsAt(payload) }
  }
  return { status: undefined, resetsAt: undefined }
}

/**
 * Classify a Claude headless terminal failure into a {@link ClassifiedError}.
 * Pure — no I/O. `unknown`/retryable is the deliberate fallback when no numeric
 * status is recoverable, so an unreadable error stays inside the envelope rather
 * than failing fast on an untrusted string label.
 */
export function classifyClaudeError(signal: ClassifyErrorSignal): ClassifiedError {
  const { status, resetsAt } = findStatusAndReset(signal)
  if (status === undefined) {
    return { category: 'unknown', transient: true }
  }

  const baseCategory = categoryForStatus(status)
  // A 429 with reset info is a usage limit (surface the reset); without it, a
  // plain rate limit. Both fail fast — the refinement only changes what we
  // surface, per R12.
  if (baseCategory === 'rate_limit' && resetsAt !== undefined) {
    return { category: 'usage_limit', transient: false, httpStatus: status, resetsAt }
  }

  return {
    category: baseCategory,
    transient: isTransientCategory(baseCategory),
    httpStatus: status,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}
