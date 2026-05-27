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

/**
 * Per-test timeout for real-tmux tiers (Tier 1 / Tier 5). Real-tmux tests boot
 * a tmux server, spawn a pane, and round-trip a `pane-died` hook — work that
 * routinely overruns Bun's 5s default `it()` timeout under the parallel-file
 * load of the full suite. That overrun was the proximate cause of the
 * two-pane-sequential-runs flake (2026-05-26): a generic "timed out after
 * 5000ms" with no diagnosis. Every real-tmux `it()` should pass this constant
 * as its timeout rather than a magic number, so the budget lives in one place.
 */
export const REAL_TMUX_TEST_TIMEOUT_MS = 30_000

/**
 * Budget for an *internal* polling assertion inside a real-tmux test — a
 * `waitForText` / `waitFor` / `withinMs(...)` / `await*Step` call that polls
 * the live pane or persisted state until it matches.
 *
 * This is deliberately distinct from (and smaller than) REAL_TMUX_TEST_TIMEOUT_MS:
 * the `it()` ceiling guards the whole test, while this guards a single repaint
 * round-trip. The two failure modes look identical from the outside ("timed
 * out") but the diagnosis differs, so they get separate knobs.
 *
 * Why 15s and not the 5s these calls used to hard-code: every real-tmux test
 * boots its own tmux server plus a detached steps-view daemon that renders Ink
 * asynchronously. The polling main thread competes with that daemon for CPU.
 * In isolation a repaint lands in well under a second, so a 5s budget looks
 * generous — but late in the full ~10-minute suite the machine is saturated
 * and a repaint can lag past 5s. Because the poll loop returns on the first
 * match, a larger budget costs nothing on the fast path; it only buys headroom
 * for the contended worst case. Caught the 2026-05-26 batch of "passes in
 * isolation, flakes in the full suite" failures (footer/banner/glyph/resume/
 * help-overlay).
 */
export const REAL_TMUX_ASSERT_TIMEOUT_MS = 15_000

// Module-level registry of live sockets. The Ctrl-C / SIGTERM handler walks
// this set so a test runner interrupted mid-suite cleans up its tmux servers
// before exiting. Without this, every interrupted run leaks a server per
// in-flight fixture and the leftovers eventually breach per-uid limits.
const LIVE_SOCKETS = new Set<SocketName>()
let signalHandlersRegistered = false

function registerSignalHandlersOnce(): void {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killAllLiveSocketsSync()
    })
  }
}

function killAllLiveSocketsSync(): void {
  for (const socket of LIVE_SOCKETS) {
    // Synchronous on purpose: a signal handler cannot await, and the parent
    // process may exit before any deferred work resolves. Errors are
    // intentionally swallowed — best-effort cleanup before the test runner
    // tears itself down.
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
  }
  LIVE_SOCKETS.clear()
}

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

  registerSignalHandlersOnce()
  LIVE_SOCKETS.add(socket)

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    LIVE_SOCKETS.delete(socket)
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
  // `kill-server` terminates the server but leaves the socket FILE on disk.
  // Remove it so a disposed fixture leaves nothing behind — otherwise dead
  // socket files accumulate until the stale-socket preload reaps them (>5min).
  for (const file of socketFilePaths(socket)) {
    await rm(file, { force: true }).catch(() => {})
  }
}

// Candidate on-disk paths for a tmux socket. tmux resolves its socket dir from
// `$TMUX_TMPDIR/tmux-<uid>` falling back to `/tmp/tmux-<uid>`; macOS surfaces
// the latter as `/private/tmp/...`. Mirrors `tests/setup/cleanup-stale-tmux.ts`.
function socketFilePaths(socket: SocketName): readonly string[] {
  const uid = process.getuid?.() ?? 0
  const dirs = new Set<string>()
  const tmuxTmpdir = process.env.TMUX_TMPDIR
  if (typeof tmuxTmpdir === 'string' && tmuxTmpdir.length > 0) {
    dirs.add(join(tmuxTmpdir, `tmux-${uid}`))
  }
  dirs.add(`/tmp/tmux-${uid}`)
  dirs.add(`/private/tmp/tmux-${uid}`)
  return [...dirs].map((dir) => join(dir, String(socket)))
}
