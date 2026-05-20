/**
 * `OrchHandle` — the typed handle returned by `launchOrchWorkflow(...)` and
 * passed to every Tier 5 matcher / assertion. Constructed in U4. U1 declares
 * the shape so subsequent units (U5, U6) can import without churn.
 */

import type { SpawnHandle } from '../../../../src/services/process/process-service.ts'
import type { Path } from '../../../../src/services/types.ts'

/**
 * The set of named workflow states `bringToState` can drive to. Plan §R8.
 *
 * - `'pre-run'`: orch has parsed runId but no step has started yet
 * - `'mid-step'`: a named step's status is `running`
 * - `'between-steps'`: a step completed and the next has not started
 * - `'completed'` / `'failed'`: run reached terminal status
 * - `'awaiting-ask'`: the ask-prompt is mounted in the right pane
 */
export type BringToStateRequest =
  | { readonly kind: 'pre-run' }
  | { readonly kind: 'mid-step'; readonly name: string }
  | { readonly kind: 'between-steps'; readonly after: string }
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'awaiting-ask' }

/**
 * Stable identifier for an orch run. Sourced from the
 * `Running workflow "<name>" (<runId>)...` stderr line at
 * `src/cli/commands/run.ts:104`. Branded to keep launcher / probe boundaries
 * type-safe.
 */
export type RunId = string & { readonly __brand: 'RunId' }

/**
 * tmux socket name derived from `'orch-' + runId`. Matches the
 * `createTmuxHost` convention.
 */
export type Socket = string & { readonly __brand: 'Socket' }

/**
 * Returned by `launchOrchWorkflow(...)`. Subsequent matchers and assertions
 * read `subprocess` (for stdin / stdoutBytes / wait) and `socket` (for the
 * external tmux probe).
 *
 * `subprocess` is spawned with `rawStreams: true` (U2 extension) so
 * `writeStdin` and `stdoutBytes` are guaranteed present.
 */
export interface OrchHandle {
  readonly runId: RunId
  readonly socket: Socket
  /** Per-test isolated state base (`mkdtemp(tmpdir()/orch-tier5-)`). */
  readonly stateBase: Path
  /** `<stateBase>/state/<runId>`. */
  readonly stateDir: Path
  /** Env that was passed to the orch subprocess (after `mergeEnv`). */
  readonly env: Readonly<Record<string, string>>
  /** Orch subprocess handle. `rawStreams: true` — writeStdin + stdoutBytes present. */
  readonly subprocess: SpawnHandle
  /**
   * Idempotent. Kills orch (graceful then forced after 1s), tears down the
   * tmux socket if still alive, removes the state base. Registered as
   * `afterEach` per cell.
   */
  teardown(): Promise<void>
}
