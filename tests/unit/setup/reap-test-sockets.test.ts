// Seam-level tests for the liveness-gated reaper. The reaper had ZERO coverage
// before this fix; these pin the predicate (prefix gate + pid liveness, no age
// window) using injected isPidAlive / killServer / removeFile and a real temp
// directory of socket-shaped files. End-to-end behavior against real tmux
// servers lives in tests/integration/tests-setup/cleanup-reaper.real.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOwnerPidAlive, reapStaleTestSockets } from '../../setup/reap-test-sockets.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reap-test-sockets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function touch(name: string): Promise<void> {
  await writeFile(join(dir, name), '', 'utf-8')
}

interface Recorder {
  readonly killed: string[]
  readonly removed: string[]
  readonly killServer: (name: string) => Promise<void>
  readonly removeFile: (path: string) => Promise<void>
}

function recorder(killServerImpl?: (name: string) => Promise<void>): Recorder {
  const killed: string[] = []
  const removed: string[] = []
  return {
    killed,
    removed,
    killServer: async (name) => {
      killed.push(name)
      if (killServerImpl !== undefined) await killServerImpl(name)
    },
    removeFile: async (path) => {
      removed.push(path)
    },
  }
}

describe('reapStaleTestSockets — reap decision', () => {
  it('reaps a reserved orch-test- socket whose owner pid is dead', async () => {
    await touch('orch-test-4242-deadbeef')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual(['orch-test-4242-deadbeef'])
    expect(rec.removed).toEqual([join(dir, 'orch-test-4242-deadbeef')])
  })

  it('skips a reserved orch-test- socket whose owner pid is alive (parallel live run)', async () => {
    await touch('orch-test-4242-deadbeef')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => true,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual([])
    expect(rec.removed).toEqual([])
  })

  it('skips a production-shaped orch-r- socket regardless of liveness (prefix gate, incident repro)', async () => {
    await touch('orch-r-2026-06-01-151213-4s')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false, // even if "dead", the prefix gate must skip it
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual([])
    expect(rec.removed).toEqual([])
  })

  it('skips a bare orch- socket whose first segment is not "test"', async () => {
    await touch('orch-something-123')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual([])
    expect(rec.removed).toEqual([])
  })

  it('skips an orch-test- entry whose pid segment is non-numeric', async () => {
    await touch('orch-test-notapid-xx')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual([])
    expect(rec.removed).toEqual([])
  })

  it('reaps only the dead-pid socket when live and dead sockets sit side by side', async () => {
    await touch('orch-test-1000-aaaa') // dead
    await touch('orch-test-2000-bbbb') // alive
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: (pid) => pid === 2000,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual(['orch-test-1000-aaaa'])
    expect(rec.removed).toEqual([join(dir, 'orch-test-1000-aaaa')])
  })
})

describe('reapStaleTestSockets — robustness', () => {
  it('still removes the socket file when killServer reports the server already gone', async () => {
    await touch('orch-test-4242-deadbeef')
    // killServer that "fails" (server already gone) by resolving — the default
    // never throws on a non-zero exit, and removeFile must still run.
    const rec = recorder(async () => {
      /* simulate already-gone server: no throw */
    })

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.removed).toEqual([join(dir, 'orch-test-4242-deadbeef')])
  })

  it('reaps purely on pid-liveness with no age input — a "new" dead socket is still reaped', async () => {
    // The file was just created (mtime = now). Under the old age heuristic this
    // would be spared; under pure liveness it is reaped because its owner is dead.
    await touch('orch-test-4242-deadbeef')
    const rec = recorder()

    await reapStaleTestSockets({
      dirs: [dir],
      isPidAlive: () => false,
      killServer: rec.killServer,
      removeFile: rec.removeFile,
    })

    expect(rec.killed).toEqual(['orch-test-4242-deadbeef'])
  })

  it('skips a missing or unreadable directory without throwing', async () => {
    const rec = recorder()

    await expect(
      reapStaleTestSockets({
        dirs: [join(dir, 'does-not-exist')],
        isPidAlive: () => false,
        killServer: rec.killServer,
        removeFile: rec.removeFile,
      }),
    ).resolves.toBeUndefined()

    expect(rec.killed).toEqual([])
  })
})

describe('isOwnerPidAlive', () => {
  it('reports this process as alive', () => {
    expect(isOwnerPidAlive(process.pid)).toBe(true)
  })

  it('reports a reaped child process as dead (ESRCH)', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    // Give the OS a moment to fully reap; the pid is no longer a live process.
    expect(isOwnerPidAlive(proc.pid)).toBe(false)
  })

  it('errs safe — treats pid 1 (alive, EPERM when not root) as alive', () => {
    // pid 1 (launchd/init) is always alive. As non-root, process.kill(1, 0)
    // throws EPERM, which must be read as alive (never wrongly reaped). As root
    // it does not throw — alive either way. This encodes the KTD-4 safe-erring.
    expect(isOwnerPidAlive(1)).toBe(true)
  })
})
