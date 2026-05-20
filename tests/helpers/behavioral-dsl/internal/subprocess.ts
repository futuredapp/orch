/**
 * Internal subprocess helpers — spawn orch via `BunProcessService` with
 * `rawStreams: true`, parse `runId` from stderr, derive the tmux socket.
 *
 * U1 is scaffold only. Real implementation lands in U4 (`launchOrchWorkflow`).
 */

import type { OrchHandle } from './lifecycle-handle.ts'

/**
 * Options accepted by the U4 launcher. Declared in U1 so the DSL barrel can
 * surface a typed `launchOrchWorkflow` signature.
 */
export interface SpawnOrchOptions {
  readonly workflowFixture: string
  /**
   * Per-step script keyed by step name. Serialized to
   * `<stateBase>/script.json` and passed via `ORCH_LIFECYCLE_SCRIPT` env var.
   * Schema lives with `ScriptedFakeRunner` (U3).
   */
  readonly script?: Readonly<Record<string, unknown>>
  readonly mode?: 'two-pane'
  readonly bringToState?: import('./lifecycle-handle.ts').BringToStateRequest
  readonly env?: Readonly<Record<string, string>>
  readonly spawnToRunIdTimeoutMs?: number
  readonly bringToStateTimeoutMs?: number
}

export const spawnOrch = async (_opts: SpawnOrchOptions): Promise<OrchHandle> => {
  throw new Error('spawnOrch not yet implemented — lands in U4')
}
