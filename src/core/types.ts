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

// The cache-key alphabet includes `:` (vars-hash separator) and, since U4,
// `>` (sub-path separator). Both are illegal as the first character so the
// brand still distinguishes user-authored step names from internal keys.
// The length bound rose from 128 → 512 to accommodate realistic sub names
// at maxDepth = 8: e.g. `simple-feature > complex-feature > … > plan:vars-<16hex>`.
const STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9:>-]*$/

const MAX_STEP_NAME_LENGTH = 512

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

// Meta entries reserve a leading `_` to keep them out of the user-facing
// `stepName()` namespace and to sort above step names in directory listings.
// Used for internal tee keys like `_rollup` (the parallel-block rollup pane).
const META_STEP_NAME_PATTERN = /^_[a-z0-9][a-z0-9:-]*$/

export function metaStepName(s: string): StepName {
  if (!META_STEP_NAME_PATTERN.test(s)) {
    throw new Error(`metaStepName must match ${META_STEP_NAME_PATTERN}, got "${s}"`)
  }
  return s as StepName
}
