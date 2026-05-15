// createRealTmuxFixture — lifecycle substrate for the real-tmux harness.
//
// Allocates an isolated tmux socket and a per-test state base, composes the
// real services (processService, fs, clock, tmux), and tears the whole thing
// down on disposal. The tmux session itself is bootstrapped later — U2's
// `mountTmuxHost(fixture)` calls `createTmuxHost` which runs `initOrchSession`
// on the fixture's socket. Booting the session in two places would conflict
// (tmux returns non-zero on a duplicate `new-session`).
//
// Generalizes the boot/teardown ceremony from
// `tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts` so
// every Tier 1 / Tier 4 test gets it for free.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from '../../../src/services/clock/index.ts'
import { BunClock } from '../../../src/services/clock/index.ts'
import type { FsService } from '../../../src/services/fs/index.ts'
import { BunFsService } from '../../../src/services/fs/index.ts'
import type { ProcessService } from '../../../src/services/process/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import {
  RealTmuxService,
  type SocketName,
  socketName,
  type TmuxService,
} from '../../../src/services/tmux/index.ts'
import type { Path } from '../../../src/services/types.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { generateRunId, type RunId } from '../../../src/state/index.ts'
import { assertNoNestedTmux } from './socket.ts'

const DEFAULT_WIDTH = 200
const DEFAULT_HEIGHT = 50

export interface CreateRealTmuxFixtureOptions {
  /**
   * Run identifier. Determines the tmux socket name (`orch-${runId}`), so
   * mounting createTmuxHost with the same runId reuses this socket
   * automatically. Defaults to `generateRunId({ clock })`.
   */
  readonly runId?: RunId
  /** Override the state-base directory. Defaults to `mkdtemp(tmpdir()/orch-harness-)`. */
  readonly stateBase?: Path
  /** Pane geometry width (-x). Defaults to 200. */
  readonly width?: number
  /** Pane geometry height (-y). Defaults to 50. */
  readonly height?: number
  /**
   * Env map consulted for the nested-tmux guard. Defaults to `process.env`.
   * Tests pass `{}` to exercise the no-TMUX branch deterministically.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RealTmuxFixture {
  readonly runId: RunId
  /** Always `socketName('orch-' + runId)` so createTmuxHost lands on it. */
  readonly socket: SocketName
  readonly stateBase: Path
  readonly tmux: TmuxService
  readonly processService: ProcessService
  readonly fs: FsService
  readonly clock: Clock
  readonly width: number
  readonly height: number

  /** Tear down: kill the tmux server, remove the state base. Idempotent. */
  dispose(): Promise<void>
  /** Async-using sugar. Same as dispose(). */
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Returns `true` only when the harness can actually boot a real tmux server —
 * `tmux` is on PATH and the current shell is not nested inside another tmux
 * session. Tests use `describe.skipIf(!canRunRealTmux())` so they auto-skip
 * in environments where the harness would throw.
 */
export function canRunRealTmux(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (Bun.which('tmux') === null) return false
  const tmuxEnv = env.TMUX
  if (typeof tmuxEnv === 'string' && tmuxEnv.length > 0) return false
  return true
}

/**
 * Tier 4 skip predicate. Requires `tmux` on PATH (via canRunRealTmux), the
 * named CLI binary on PATH, AND `RUN_REAL_TMUX_E2E=1` in the environment.
 * Tier 4 is developer-opt-in until a future PR adds a scheduled CI job — see
 * the plan's `Operational / Rollout Notes`.
 */
export function canRunRealTmuxE2E(
  cli: 'claude' | 'codex',
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!canRunRealTmux(env)) return false
  if (Bun.which(cli) === null) return false
  return env.RUN_REAL_TMUX_E2E === '1'
}

export async function createRealTmuxFixture(
  opts: CreateRealTmuxFixtureOptions = {},
): Promise<RealTmuxFixture> {
  const env = opts.env ?? (process.env as Readonly<Record<string, string | undefined>>)
  // Fail fast — booting our own server from inside tmux would silently route
  // commands to the user's outer server.
  assertNoNestedTmux(env)

  const processService = new BunProcessService()
  const tmux = new RealTmuxService({ processService })
  const fs = new BunFsService()
  const clock = new BunClock()

  const runId = opts.runId ?? generateRunId({ clock })
  // createTmuxHost derives its socket as `socketName('orch-' + runId)`.
  // Matching here lets the fixture and any later `mountTmuxHost(fixture, …)`
  // call hit the same tmux server without an extra config knob.
  const socket = socketName(`orch-${runId}`)

  let stateBase: Path
  let ownsStateBase: boolean
  if (opts.stateBase !== undefined) {
    stateBase = opts.stateBase
    ownsStateBase = false
  } else {
    const created = await mkdtemp(join(tmpdir(), 'orch-harness-'))
    stateBase = toPath(created)
    ownsStateBase = true
  }

  const width = opts.width ?? DEFAULT_WIDTH
  const height = opts.height ?? DEFAULT_HEIGHT

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await killServerQuietly(socket)
    if (ownsStateBase) await rm(stateBase, { recursive: true, force: true }).catch(() => {})
  }

  return {
    runId,
    socket,
    stateBase,
    tmux,
    processService,
    fs,
    clock,
    width,
    height,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

async function killServerQuietly(socket: SocketName): Promise<void> {
  // Bun.spawn avoids the noisy TmuxCommandError that RealTmuxService throws
  // when the server is already gone — teardown must be idempotent.
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}
