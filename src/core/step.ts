import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import type { SchemaWrapper } from './schema.ts'
import { type StepName, stepName } from './types.ts'

export interface AgentStepConfig<T = unknown> {
  readonly kind: 'agent'
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

export interface CommitStepConfig {
  readonly kind: 'commit'
  readonly message: string
}

export type StepConfig<T = unknown> = AgentStepConfig<T> | CommitStepConfig

export interface Step<T = unknown> {
  readonly name: StepName
  readonly config: StepConfig<T>
}

const RESERVED_PREFIX = 'commit:'

export const step = {
  define<T = unknown>(name: string, config: Omit<AgentStepConfig<T>, 'kind'>): Step<T> {
    if (name.startsWith(RESERVED_PREFIX)) {
      throw new Error(
        `step.define() cannot use reserved prefix "${RESERVED_PREFIX}" — use the commit() factory instead`,
      )
    }
    return Object.freeze({ name: stepName(name), config: { kind: 'agent' as const, ...config } })
  },
} as const
