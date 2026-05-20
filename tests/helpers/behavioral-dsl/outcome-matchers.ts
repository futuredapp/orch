/**
 * Outcome matchers. `cleanly()`, `doesNotExist()`, `balancedEscapes()`, and
 * friends are projections of the §6.5 invariant contract — they MUST stay
 * structurally aligned with what `runInvariantContract` evaluates.
 *
 * `withinMs(ms)` is the one meta-matcher: it bounds the polling window the
 * assertion waits over before capturing the final snapshot.
 *
 * Stubs in U1, bodies in U6.
 */

import type { Matcher, PollingBudget } from './internal/snapshot.ts'

/**
 * Meta-matcher: instructs `assertOrchExits` / `assertTmuxSession` /
 * `assertWorkflowState` / `assertTerminalState` to keep polling and
 * re-capturing snapshots until either every matcher passes or `ms` elapses.
 */
export const withinMs = (_ms: number): PollingBudget => {
  throw new Error('withinMs not yet implemented — lands in U6')
}

export const cleanly = (): Matcher => {
  throw new Error('cleanly not yet implemented — lands in U6')
}

export const doesNotExist = (): Matcher => {
  throw new Error('doesNotExist not yet implemented — lands in U6')
}

export const balancedEscapes = (): Matcher => {
  throw new Error('balancedEscapes not yet implemented — lands in U6')
}

export const noOrphanChildren = (): Matcher => {
  throw new Error('noOrphanChildren not yet implemented — lands in U6')
}

export const hasIntactPerStepFiles = (): Matcher => {
  throw new Error('hasIntactPerStepFiles not yet implemented — lands in U6')
}
