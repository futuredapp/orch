import type { Clock } from '../services/index.ts'

/** Branded run identifier: r-YYYY-MM-DD-HHMMSS-xx where HHMMSS is local
 *  wall-clock time and xx is 2 cryptographically random base-36 chars. */
export type RunId = string & { readonly __brand: 'RunId' }

/** Pattern all RunIds must match. Exported for RunRegistry's directory filter. */
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/

const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Validates a string as a RunId. Throws on invalid format. */
export function runId(s: string): RunId {
  if (!RUN_ID_PATTERN.test(s)) {
    throw new Error(`Invalid RunId: "${s}"`)
  }
  return s as RunId
}

/** Generates a new RunId from local wall-clock time plus cryptographic entropy.
 *  Format: r-YYYY-MM-DD-HHMMSS-xx where HHMMSS is local time and xx is 2
 *  cryptographically random base-36 chars (~1296 same-second slots). */
export function generateRunId(deps: { readonly clock: Clock }): RunId {
  const now = deps.clock.now()
  const d = new Date(now)
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const rand = randomBase36Pair()
  return runId(`r-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}-${rand}`)
}

function randomBase36Pair(): string {
  const rnd = new Uint8Array(2)
  crypto.getRandomValues(rnd)
  const a = rnd[0] ?? 0
  const b = rnd[1] ?? 0
  return `${BASE36_ALPHABET[a % 36] ?? '0'}${BASE36_ALPHABET[b % 36] ?? '0'}`
}
