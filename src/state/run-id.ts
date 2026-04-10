import type { Clock } from '../services/index.ts'

/** Branded run identifier: r-YYYY-MM-DD-xxxx where xxxx is 4 base-36 chars. */
export type RunId = string & { readonly __brand: 'RunId' }

/** Pattern all RunIds must match. Exported for RunRegistry's directory filter. */
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/

/** Validates a string as a RunId. Throws on invalid format. */
export function runId(s: string): RunId {
  if (!RUN_ID_PATTERN.test(s)) {
    throw new Error(`Invalid RunId: "${s}"`)
  }
  return s as RunId
}

/** Generates a new RunId from the current clock time.
 *  Format: r-YYYY-MM-DD-<slug> where slug = clock.now() in base-36, last 4 chars, zero-padded. */
export function generateRunId(deps: { readonly clock: Clock }): RunId {
  const now = deps.clock.now()
  const d = new Date(now)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const slug = now.toString(36).slice(-4).padStart(4, '0')
  return runId(`r-${yyyy}-${mm}-${dd}-${slug}`)
}
