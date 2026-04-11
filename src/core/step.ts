import type { Runner } from '../runners/index.ts'
import { type StepName, stepName } from './types.ts'

export interface StepConfig {
  readonly agent: Runner
  readonly prompt?: string
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
