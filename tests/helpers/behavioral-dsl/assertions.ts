/**
 * Assertions — the top-level DSL verbs cells call against the implicit
 * "current" `OrchHandle`. Each assertion takes a list of matchers (and
 * optionally a `PollingBudget` from `withinMs(...)`) and either:
 *   - succeeds the first time every matcher passes, OR
 *   - throws with the failing snapshot inlined for diagnostic purposes.
 *
 * Stubs in U1; `assertOrchExits` / `assertTmuxSession` / `assertTerminalState`
 * / `assertWorkflowState` / `assertAllInvariants` / `expectInvariantViolation`
 * land in U6. `assertLeftPane` / `assertRightPane` land in U8.
 */

import type { ScenarioTag } from './internal/invariants.ts'
import type { Matcher, PollingBudget } from './internal/snapshot.ts'

export type AssertionArg = Matcher | PollingBudget

export const assertLeftPane = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertLeftPane not yet implemented — lands in U8')
}

export const assertRightPane = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertRightPane not yet implemented — lands in U8')
}

export const assertWorkflowState = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertWorkflowState not yet implemented — lands in U8')
}

export const assertOrchExits = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertOrchExits not yet implemented — lands in U6')
}

export const assertTmuxSession = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertTmuxSession not yet implemented — lands in U6')
}

export const assertTerminalState = async (..._args: readonly AssertionArg[]): Promise<void> => {
  throw new Error('assertTerminalState not yet implemented — lands in U6')
}

/**
 * Bulk assertion over the entire applicable §6.5 contract row for the given
 * scenario tag. Use when a cell wants to assert the full invariant set without
 * itemizing matchers. Lands in U6.
 */
export const assertAllInvariants = async (
  _scenario: ScenarioTag,
  ..._args: readonly AssertionArg[]
): Promise<void> => {
  throw new Error('assertAllInvariants not yet implemented — lands in U6')
}

/**
 * Inverted assertion: PASSES when the snapshot violates the named contract
 * row, FAILS when the violation list becomes empty (i.e., orch was fixed —
 * the cell must be deleted, not edited). Plan Risk R-D's programmatic
 * defense. Lands in U6, consumed by U9.
 */
export const expectInvariantViolation = async (
  _scenario: ScenarioTag,
  ..._args: readonly AssertionArg[]
): Promise<void> => {
  throw new Error('expectInvariantViolation not yet implemented — lands in U6')
}
