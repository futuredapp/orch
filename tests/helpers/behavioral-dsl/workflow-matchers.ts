/**
 * Workflow-state matchers. Pure projectors over `LifecycleSnapshot`'s
 * `stateStatus` / `stepStatuses` fields. Stubs in U1, bodies in U8.
 */

import type { Matcher, StateStatus, StepStatus } from './internal/snapshot.ts'

export const isRunningStep = (_stepName: string): Matcher => {
  throw new Error('isRunningStep not yet implemented — lands in U8')
}

export const hasStatus = (_status: StateStatus): Matcher => {
  throw new Error('hasStatus not yet implemented — lands in U8')
}

export const hasStepStatus = (_stepName: string, _status: StepStatus): Matcher => {
  throw new Error('hasStepStatus not yet implemented — lands in U8')
}

export const hasExitCode = (_code: number): Matcher => {
  throw new Error('hasExitCode not yet implemented — lands in U8')
}

export const hasExitedBySignal = (_signal: NodeJS.Signals): Matcher => {
  throw new Error('hasExitedBySignal not yet implemented — lands in U8')
}
