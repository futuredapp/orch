/**
 * Public DSL launcher. The only entry point tests use to boot orch as a
 * subprocess. U1 declares the signatures; U4 fills in the bodies.
 */

import type { OrchHandle } from './internal/lifecycle-handle.ts'
import type { SpawnOrchOptions } from './internal/subprocess.ts'

/**
 * Boot orch under test, parse runId, derive socket, drive to `bringToState`.
 *
 * Implementation lands in U4. The signature is final so downstream cells can
 * type-check their imports today.
 */
export const launchOrchWorkflow = async (
  _fixtureName: string,
  _opts?: Omit<SpawnOrchOptions, 'workflowFixture'>,
): Promise<OrchHandle> => {
  throw new Error('launchOrchWorkflow not yet implemented — lands in U4')
}

/**
 * Returns a `StepScript` of shape `{ kind: 'wait-for-file', gatePath: ... }`.
 * Plan §Key Technical Decisions. Lands in U4 alongside the launcher.
 */
export interface HoldUntilReleasedScript {
  readonly kind: 'wait-for-file'
  /** Absolute path under `<stateBase>/`. The DSL's `release(stepName)` writes this file. */
  readonly gatePath: string
}

export const holdUntilReleased = (): HoldUntilReleasedScript => {
  throw new Error('holdUntilReleased not yet implemented — lands in U4')
}
