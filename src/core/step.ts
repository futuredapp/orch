import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import { type StepName, stepName } from './types.ts'

export interface StepConfig {
  readonly agent: Runner
  readonly prompt?: string
  /**
   * Post-run assertions against the filesystem and git state. A single
   * Validator is normalized internally to a one-element array. When any
   * validator fails, the executor throws `ValidationError` — same
   * crash/resume semantics as `StepError`.
   */
  readonly validate?: Validator | ReadonlyArray<Validator>
}

export interface Step {
  readonly name: StepName
  readonly config: StepConfig
}

export const step = {
  define(name: string, config: StepConfig): Step {
    return Object.freeze({ name: stepName(name), config })
  },
} as const
