import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import type { SchemaWrapper } from './schema.ts'
import type { InteractiveResult, StepMode } from './types.ts'
import { type StepName, stepName } from './types.ts'

// ---------------------------------------------------------------------------
// AgentStepConfig — the config stored on a Step
// ---------------------------------------------------------------------------

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
  readonly mode?: StepMode
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

// ---------------------------------------------------------------------------
// step.define — input types for the two overloads
// ---------------------------------------------------------------------------

/** Interactive overload input: mode:'interactive' forbids `returns`. */
type InteractiveStepInput = {
  readonly agent: Runner
  readonly prompt?: string
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly mode: 'interactive'
  readonly returns?: never
}

/** Autonomous overload input: optional `returns` for structured output. */
type AutonomousStepInput<T> = Omit<AgentStepConfig<T>, 'kind'>

// ---------------------------------------------------------------------------
// StepFactory — overloaded define method
// ---------------------------------------------------------------------------

interface StepFactory {
  define(name: string, config: InteractiveStepInput): Step<InteractiveResult>
  define<T = unknown>(name: string, config: AutonomousStepInput<T>): Step<T>
}

function defineStep(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): Step {
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `step.define() cannot use reserved prefix "${RESERVED_PREFIX}" — use the commit() factory instead`,
    )
  }
  if (config.mode === 'interactive' && 'returns' in config && config.returns !== undefined) {
    throw new Error(
      `step.define("${name}"): interactive steps cannot have "returns:" — ` +
        'structured output is not available in interactive mode',
    )
  }
  return Object.freeze({ name: stepName(name), config: { kind: 'agent' as const, ...config } })
}

export const step: StepFactory = {
  define: defineStep as StepFactory['define'],
}
