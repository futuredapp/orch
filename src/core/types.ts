import { z } from 'zod'

export type { Path } from '../services/index.ts'
export { path } from '../services/index.ts'
export type { RunId } from '../state/index.ts'
export { generateRunId, runId } from '../state/index.ts'

// ---------------------------------------------------------------------------
// StepMode — interactive vs autonomous execution
// ---------------------------------------------------------------------------

export type StepMode = 'interactive' | 'autonomous'

// ---------------------------------------------------------------------------
// InteractiveResult — return type for interactive steps
// ---------------------------------------------------------------------------

export interface InteractiveResult {
  readonly exitCode: number
  readonly durationMs: number
  readonly sessionId: string
}

export const InteractiveResultSchema = z.object({
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
}) satisfies z.ZodType<InteractiveResult>

// ---------------------------------------------------------------------------
// StepName — branded string for step identifiers
// ---------------------------------------------------------------------------

export type StepName = string & { readonly __brand: 'StepName' }

const STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9:-]*$/

const MAX_STEP_NAME_LENGTH = 128

export function stepName(s: string): StepName {
  if (s.length === 0) {
    throw new Error('StepName must not be empty')
  }
  if (s.length > MAX_STEP_NAME_LENGTH) {
    throw new Error(`StepName must be at most ${MAX_STEP_NAME_LENGTH} characters, got ${s.length}`)
  }
  if (!STEP_NAME_PATTERN.test(s)) {
    throw new Error(`StepName must match ${STEP_NAME_PATTERN}, got "${s}"`)
  }
  return s as StepName
}
