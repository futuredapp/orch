// MIGRATED → tests-new/integration/real-tmux/cleanup-reaper.real.integration.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Headline verification for the stale-socket reaper, against REAL tmux servers.
//
// Each `it` boots one or more real `tmux -L <socket>` servers, runs the actual
// `reapStaleTestSockets()` sweep (default I/O seams — real process.kill, real
// kill-server, real rm), and asserts the live server's actual presence or
// absence. Every success criterion from the fix plan is exercised here against
// the real thing, not a fake.
//
// Gated on `canRunRealTmux()` (tmux on PATH, not nested in a tmux session) and
// self-skips otherwise. Every booted socket is torn down in afterEach,
// independent of the assertion outcome, so a failing test never leaks a server.

import { afterEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BunClock } from '../../../src/services/clock/index.ts'
import { type SocketName, socketName } from '../../../src/services/tmux/index.ts'
import { generateRunId } from '../../../src/state/index.ts'
import { canRunRealTmux, REAL_TMUX_TEST_TIMEOUT_MS } from '../../helpers/real-tmux/index.ts'
import { candidateSocketDirs, reapStaleTestSockets } from '../../setup/reap-test-sockets.ts'

const bootedSockets: SocketName[] = []

afterEach(async () => {
  for (const socket of bootedSockets) await killServer(socket)
  bootedSockets.length = 0
})

function reservedSocketForPid(pid: number): SocketName {
  return socketName(`orch-test-${pid}-${randomBytes(4).toString('hex')}`)
}

// Boot a real, detached tmux server with a single `probe` session running cat.
// Tracks the socket for guaranteed afterEach teardown before asserting boot.
async function bootServer(socket: SocketName): Promise<void> {
  bootedSockets.push(socket)
  const proc = Bun.spawn(
    ['tmux', '-L', String(socket), 'new-session', '-d', '-s', 'probe', 'cat'],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  expect(await proc.exited).toBe(0)
}

async function isServerAlive(socket: SocketName): Promise<boolean> {
  const proc = Bun.spawn(['tmux', '-L', String(socket), 'has-session', '-t', 'probe'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await proc.exited) === 0
}

// Kill the server AND remove its socket file. `kill-server` terminates the
// server but leaves the socket file on disk; a live-pid socket survives the
// reaper, so without this the file would linger for the whole suite (its owner
// pid is the still-alive test runner). Mirrors fixture.ts's killServerQuietly.
async function killServer(socket: SocketName): Promise<void> {
  const proc = Bun.spawn(['tmux', '-L', String(socket), 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
  for (const dir of candidateSocketDirs()) {
    await rm(join(dir, String(socket)), { force: true }).catch(() => {})
  }
}

function socketFileExists(socket: SocketName): boolean {
  return candidateSocketDirs().some((dir) => existsSync(join(dir, String(socket))))
}

// A guaranteed-dead pid: spawn a trivial process and wait for it to exit.
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  return proc.pid
}

describe.skip('reapStaleTestSockets against real tmux', () => {
  it(
    'reaps a reserved orch-test- server whose owner pid is dead (server gone + socket file gone)',
    async () => {
      const socket = reservedSocketForPid(await deadPid())
      await bootServer(socket)
      expect(await isServerAlive(socket)).toBe(true)

      await reapStaleTestSockets()

      expect(await isServerAlive(socket)).toBe(false)
      expect(socketFileExists(socket)).toBe(false)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'leaves a reserved orch-test- server whose owner pid is alive (live parallel run)',
    async () => {
      // process.pid is the test runner — guaranteed alive across the sweep.
      const socket = reservedSocketForPid(process.pid)
      await bootServer(socket)

      await reapStaleTestSockets()

      expect(await isServerAlive(socket)).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'leaves a live production orch-r- server untouched (incident repro)',
    async () => {
      // The exact shape of the server the incident killed: a real run id, booted
      // and active while a sweep runs. The prefix gate must spare it.
      const runId = generateRunId({ clock: new BunClock() })
      const socket = socketName(`orch-${runId}`)
      await bootServer(socket)

      await reapStaleTestSockets()

      expect(await isServerAlive(socket)).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'reaps only the dead-pid server when a dead and a live reserved server coexist (parallel safety)',
    async () => {
      const deadSocket = reservedSocketForPid(await deadPid())
      const liveSocket = reservedSocketForPid(process.pid)
      await bootServer(deadSocket)
      await bootServer(liveSocket)

      await reapStaleTestSockets()

      expect(await isServerAlive(deadSocket)).toBe(false)
      expect(await isServerAlive(liveSocket)).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'errs safe — an alive-but-unrelated owner pid is skipped (missed cleanup, never wrongful kill)',
    async () => {
      // pid alive, unrelated to any orch run. Documents that the sweep prefers a
      // harmless missed cleanup over a wrongful kill (KTD-4).
      const socket = reservedSocketForPid(process.pid)
      await bootServer(socket)

      await reapStaleTestSockets()

      expect(await isServerAlive(socket)).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'determines reap purely by pid liveness, independent of socket age',
    async () => {
      // Both servers are freshly booted (age ~0). Under the old 5-minute age
      // window neither would be reaped; under pure liveness, only the dead one is.
      const freshDead = reservedSocketForPid(await deadPid())
      const freshLive = reservedSocketForPid(process.pid)
      await bootServer(freshDead)
      await bootServer(freshLive)

      await reapStaleTestSockets()

      expect(await isServerAlive(freshDead)).toBe(false)
      expect(await isServerAlive(freshLive)).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
