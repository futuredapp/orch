// ---------------------------------------------------------------------------
// Codex headless error classification (R6, R12).
//
// `codex exec --json` is a lossy surface: the typed `codexErrorInfo` /
// `httpStatusCode` / `will_retry` fields live only on the app-server protocol,
// not here. What we get is:
//
//   - `{"type":"turn.failed","error":{"message":"..."}}` + process exit code 1
//     — the AUTHORITATIVE terminal signal (R6); and
//   - `{"type":"error","message":"..."}` lines — emitted for BOTH transient
//     retries and fatal errors, with no status and no category. Best-effort
//     string-matching only.
//
// So classification keys off the message text: an explicit `last status: NNN`
// or a bare 3-digit status maps via the numeric table (R12); otherwise we keyword
// -match the documented phrasings (`server_is_overloaded` / "at capacity" /
// "high demand" → overload, "usage limit" → usage_limit, etc.). Anything we can't
// place is `unknown` — retryable within the envelope — so an unreadable Codex
// failure never silently fails fast. (Codex never emits the literal "529"; its
// overload analog is HTTP 503 + `server_is_overloaded`.)
// ---------------------------------------------------------------------------

import {
  type ClassifiedError,
  categoryForStatus,
  isLaunchFailureSignal,
  isTransientCategory,
} from '../../core/recovery/index.ts'
import type { ClassifyErrorSignal } from '../types.ts'

/** Gather every text fragment that might carry a category hint: the terminal
 *  message, any nested `error.message` / `error.code` on its data, and the
 *  lossy `error` info lines. Joined lowercase for keyword matching. */
function collectErrorText(signal: ClassifyErrorSignal): string {
  const parts: string[] = []
  if (signal.finalEvent.type === 'error') parts.push(signal.finalEvent.message)

  const data = signal.finalEvent.data
  if (typeof data === 'object' && data !== null) {
    const error = (data as Record<string, unknown>).error
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>
      if (typeof e.message === 'string') parts.push(e.message)
      if (typeof e.code === 'string') parts.push(e.code)
    }
  }

  for (const info of signal.infoEvents) {
    const message = info.payload?.message
    if (typeof message === 'string') parts.push(message)
  }

  return parts.join(' \n ').toLowerCase()
}

/** A 3-digit HTTP status the message states explicitly (`last status: 429`, or a
 *  standalone `503`). Returns the first match, or undefined. */
function statusFromText(text: string): number | undefined {
  const explicit = /\b(?:last status:?\s*)?(\d{3})\b/.exec(text)
  if (explicit?.[1] === undefined) return undefined
  const status = Number(explicit[1])
  return status >= 400 && status <= 599 ? status : undefined
}

/** Keyword fallback when no numeric status is present. Ordered most-specific
 *  first so "usage limit" wins over a generic "limit". */
function categoryFromKeywords(text: string): ClassifiedError | undefined {
  if (/usage limit|out of credits|usage_limit_reached/.test(text)) {
    return { category: 'usage_limit', transient: false }
  }
  if (/server_is_overloaded|overloaded|at capacity|high demand|slow_down/.test(text)) {
    return { category: 'overload', transient: true }
  }
  if (/too many requests|rate.?limit/.test(text)) {
    return { category: 'rate_limit', transient: false }
  }
  if (/unauthorized|invalid api key|not logged in|authentication/.test(text)) {
    return { category: 'auth', transient: false }
  }
  // Word-boundaried: a bare substring match (e.g. a path containing "billing")
  // must not flip a retryable failure into a non-retryable fail-fast.
  if (/\b(?:quota|billing)\b/.test(text)) {
    return { category: 'billing', transient: false }
  }
  return undefined
}

/**
 * Classify a Codex headless terminal failure into a {@link ClassifiedError}.
 * Pure — no I/O. The `turn.failed` + exit-1 pairing is the authoritative
 * terminal trigger; the category itself is best-effort string-matching on the
 * lossy message, defaulting to `unknown`/retryable.
 */
export function classifyCodexError(signal: ClassifyErrorSignal): ClassifiedError {
  const text = collectErrorText(signal)

  const status = statusFromText(text)
  if (status !== undefined) {
    const category = categoryForStatus(status)
    return { category, transient: isTransientCategory(category), httpStatus: status }
  }

  const byKeyword = categoryFromKeywords(text)
  if (byKeyword !== undefined) return byKeyword

  // A crash before any stdout protocol event (bad `.codex/rules`, missing
  // binary, auth failure on first byte) is a launch/config failure, not a
  // retryable hiccup — fail fast so the stderr surfaces instead of a 5-minute
  // silent backoff. Consulted only here, after status/keyword checks, so a real
  // transient turn.failed (reported on stdout) is never reclassified.
  if (isLaunchFailureSignal(signal)) return { category: 'launch', transient: false }

  return { category: 'unknown', transient: true }
}
