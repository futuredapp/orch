import type { Clock } from '../services/index.ts'

/** Branded run identifier: r-YYYY-MM-DD-xxxxyy where xxxx is 4 clock-derived base-36 chars
 *  and yy is 2 cryptographically random base-36 chars (6-char slug total). */
export type RunId = string & { readonly __brand: 'RunId' }

/** Pattern all RunIds must match. Exported for RunRegistry's directory filter. */
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/

const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Validates a string as a RunId. Throws on invalid format. */
export function runId(s: string): RunId {
  if (!RUN_ID_PATTERN.test(s)) {
    throw new Error(`Invalid RunId: "${s}"`)
  }
  return s as RunId
}

/** Generates a new RunId from the current clock time plus cryptographic entropy.
 *  Format: r-YYYY-MM-DD-xxxxyy where xxxx = clock.now() base-36 (last 4 chars, zero-padded)
 *  and yy = 2 bytes of crypto randomness mapped to base-36. */
export function generateRunId(deps: { readonly clock: Clock }): RunId {
  const now = deps.clock.now()
  const d = new Date(now)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const clockSlug = now.toString(36).slice(-4).padStart(4, '0')
  const randSlug = randomBase36Pair()
  return runId(`r-${yyyy}-${mm}-${dd}-${clockSlug}${randSlug}`)
}

function randomBase36Pair(): string {
  const rnd = new Uint8Array(2)
  crypto.getRandomValues(rnd)
  const a = rnd[0] ?? 0
  const b = rnd[1] ?? 0
  return `${BASE36_ALPHABET[a % 36] ?? '0'}${BASE36_ALPHABET[b % 36] ?? '0'}`
}
