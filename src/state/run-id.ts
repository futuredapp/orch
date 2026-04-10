import type { Clock } from '../services/index.ts'

/** Branded run identifier: r-YYYY-MM-DD-xxxx where xxxx is 4 base-36 chars. */
export type RunId = string & { readonly __brand: 'RunId' }

/** Pattern all RunIds must match. Exported for RunRegistry's directory filter. */
export const RUN_ID_PATTERN = /^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/

/** Validates a string as a RunId. Throws on invalid format. */
export function runId(_s: string): RunId {
  throw new Error('Not implemented')
}

/** Generates a new RunId from the current clock time. */
export function generateRunId(_deps: { readonly clock: Clock }): RunId {
  throw new Error('Not implemented')
}
