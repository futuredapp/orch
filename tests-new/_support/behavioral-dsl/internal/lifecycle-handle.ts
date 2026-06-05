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
 * tmux socket name the spawned orch run booted on. The launcher allocates a
 * reserved `orch-test-<pid>-<nonce>` socket and bridges it into the subprocess
 * via `ORCH_TMUX_SOCKET`, so this is that reserved name (not `orch-${runId}`).
 * Used by Tier 5 matchers for the external tmux probe.
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
  /** Where the workflow body runs. Equals `repoRoot` unless a worktree step entered. */
  readonly workflowCwd: Path
  /** Set when `initGitRepo: true`; the temp repo root. Otherwise the fixture cwd. */
  readonly repoRoot: Path
  /** Env that was passed to the orch subprocess (after `mergeEnv`). */
  readonly env: Readonly<Record<string, string>>
  /** Orch subprocess handle. `rawStreams: true` — writeStdin + stdoutBytes present. */
  readonly subprocess: SpawnHandle
  /**
   * Send a puppet command to the named step's control file. The step must
   * have been configured with `puppet()` in the launcher's `script` map.
   * Each method appends an NDJSON line and waits for the runner's matching
   * ack file, so the call returns only once the command has been observed.
   */
  agent(stepName: string): AgentControl
  /**
   * Idempotent. Kills orch (graceful then forced after 1s), tears down the
   * tmux socket if still alive, removes the state base. Registered as
   * `afterEach` per cell.
   */
  teardown(): Promise<void>
}

/**
 * The runner-side puppet command surface, scoped to one step. Returned by
 * `handle.agent(stepName)`. Each method appends an NDJSON line to the
 * step's control file and waits for the runner-side ack.
 */
export interface AgentControl {
  emit(event: {
    readonly kind: string
    readonly type?: string
    readonly [k: string]: unknown
  }): Promise<void>
  writeFile(relPath: string, content: string): Promise<void>
  runShell(command: string): Promise<void>
  complete(opts?: { readonly structuredOutput?: unknown }): Promise<void>
  fail(opts: { readonly message: string; readonly exitCode?: number }): Promise<void>
  wait(ms: number): Promise<void>
}
