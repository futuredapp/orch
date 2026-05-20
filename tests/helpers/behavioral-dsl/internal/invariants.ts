/**
 * Invariant contract — the single source of truth for "what `cleanly()`,
 * `doesNotExist()`, `balancedEscapes()` (etc.) compose into for a given
 * scenario." Plan §6.5 of the origin doc is the spec.
 *
 * U1 is scaffold. U6 wires the per-scenario contract table; U10 splits the
 * legacy `closeTerminal` row into `closeStdin` + `signal-sighup`.
 */

import type { LifecycleSnapshot } from './snapshot.ts'

/**
 * Scenario tags name a row of the §6.5 contract. Each scenario maps to a
 * `Matcher[]` that defines what must hold for the run to be "clean" under that
 * stimulus. Adding a tag is a one-line addition to U6's contract table.
 */
export type ScenarioTag =
  | 'signal-sigint'
  | 'signal-sigterm'
  | 'signal-sighup'
  | 'close-stdin'
  | 'attach-tty-ctrl-c'
  | 'pane-q-during-run'
  | 'pane-q-at-completion'
  | 'external-kill-pane'
  | 'external-kill-session'
  | 'external-kill-server'

export interface InvariantViolation {
  /** Name of the matcher that failed (e.g. `'cleanly'`, `'doesNotExist'`). */
  readonly matcher: string
  /** Human-readable detail — names the actual value alongside the expectation. */
  readonly detail: string
}

export const runInvariantContract = (
  _snapshot: LifecycleSnapshot,
  _scenario: ScenarioTag,
): readonly InvariantViolation[] => {
  throw new Error('runInvariantContract not yet implemented — lands in U6')
}
