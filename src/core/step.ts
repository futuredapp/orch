import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import type { SchemaWrapper } from './schema.ts'
import { type StepName, stepName } from './types.ts'

export interface StepConfig<T = unknown> {
  readonly agent: Runner
  readonly prompt?: string
  /**
   * Post-run assertions against the filesystem and git state. A single
   * Validator is normalized internally to a one-element array. When any
   * validator fails, the executor throws `ValidationError` — same
   * crash/resume semantics as `StepError`.
   */
  readonly validate?: Validator | ReadonlyArray<Validator>
  /** Zod schema for structured CLI output. Enables `--json-schema` and Zod validation. */
  readonly returns?: SchemaWrapper<T>
}

export interface Step<T = unknown> {
  readonly name: StepName
  readonly config: StepConfig<T>
}

export const step = {
  define<T = unknown>(name: string, config: StepConfig<T>): Step<T> {
    return Object.freeze({ name: stepName(name), config })
  },
} as const
