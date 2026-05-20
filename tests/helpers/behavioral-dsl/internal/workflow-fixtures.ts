/**
 * Workflow-fixture registry — maps a fixture name (e.g. `'two-step-linear'`)
 * to the on-disk fixture directory containing its `orch.config.ts` and the
 * workflow name `bun src/cli/main.ts run <name>` should invoke.
 *
 * U1 declares the lookup signature; U4 registers `'two-step-linear'` after
 * U3 lands the fixture file.
 */

import type { Path } from '../../../../src/services/types.ts'

export interface FixtureLocation {
  /** Directory containing `orch.config.ts` for the fixture. Passed as orch's `cwd`. */
  readonly cwd: Path
  /** Workflow name the orch CLI resolves against `orch.config.ts`. */
  readonly workflowName: string
}

export const resolveFixture = (_fixtureName: string): FixtureLocation => {
  throw new Error('resolveFixture not yet implemented — lands in U4 (registers two-step-linear)')
}
