import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { claude } from '../../../../src/runners/claude/index.ts'
import { createCaptureLock } from '../../../../src/runners/codex/capture-lock.ts'
import { codex } from '../../../../src/runners/codex/index.ts'
import type { CaptureLock, CaptureSessionIdContext } from '../../../../src/runners/types.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import type { FsService } from '../../../../src/services/fs/fs-service.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { type Path, path } from '../../../../src/services/types.ts'

const FIXED_EPOCH = Date.UTC(2026, 4, 13, 12, 0, 0)
const SESSIONS_ROOT = '/codex-sessions'
const TODAY_DIR = `${SESSIONS_ROOT}/2026/05/13`
const WORK_CWD = path('/work')

function sessionMetaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'session_meta', payload })
}

function flushPendingPolls(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeCodexDeps(): { fs: FakeFsService; ps: FakeProcessService; clock: FakeClock } {
  const clock = new FakeClock(FIXED_EPOCH)
  const fs = new FakeFsService({ clock })
  const ps = new FakeProcessService()
  ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.120.0'], exitCode: 0 })
  return { fs, ps, clock }
}

function makeCtx(
  deps: { fs: FakeFsService; clock: FakeClock; lock: CaptureLock },
  overrides?: Partial<CaptureSessionIdContext>,
): CaptureSessionIdContext {
  return {
    cwd: WORK_CWD,
    fs: deps.fs,
    clock: deps.clock,
    lock: deps.lock,
    timeoutMs: 5000,
    ...overrides,
  }
}

describe('codex().captureSessionId', () => {
  const prevEnv = process.env.ORCH_CODEX_SESSIONS_ROOT
  beforeEach(() => {
    process.env.ORCH_CODEX_SESSIONS_ROOT = SESSIONS_ROOT
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ORCH_CODEX_SESSIONS_ROOT
    else process.env.ORCH_CODEX_SESSIONS_ROOT = prevEnv
  })

  it('captures a thread_id when exactly one new rollout with a matching cwd appears', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lock = createCaptureLock()

    const handle = runner.captureSessionId?.(makeCtx({ ...deps, lock }))
    expect(handle).toBeDefined()

    await handle?.snapshotReady

    await deps.fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      sessionMetaLine({ id: 'codex-thread-x', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    deps.clock.advance(100)

    expect(await handle?.result).toEqual({ sessionId: 'codex-thread-x' })
  })

  it('returns ambiguous when two new rollouts share the workflow cwd', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lock = createCaptureLock()

    const handle = runner.captureSessionId?.(makeCtx({ ...deps, lock }))
    await handle?.snapshotReady

    await deps.fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      sessionMetaLine({ id: 'one', cwd: WORK_CWD }),
    )
    await deps.fs.writeFile(
      path(`${TODAY_DIR}/C.jsonl`),
      sessionMetaLine({ id: 'two', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    deps.clock.advance(100)

    expect(await handle?.result).toEqual({ error: 'ambiguous' })
  })

  it('returns empty when the capture window elapses with no matching rollout', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lock = createCaptureLock()

    const handle = runner.captureSessionId?.(makeCtx({ ...deps, lock }))
    await handle?.snapshotReady
    await flushPendingPolls()
    deps.clock.advance(5000)

    expect(await handle?.result).toEqual({ error: 'empty' })
  })

  it('returns error when the underlying fs throws mid-poll, and still releases the lock', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lock = createCaptureLock()

    // Wrap fs.readDir to throw on the third call (initial snapshot is call 1,
    // iter-1 reads are calls 2 + 3 — the second of those flips into error).
    let readDirCalls = 0
    const wrappedFs: FsService = {
      readFile: deps.fs.readFile.bind(deps.fs),
      writeFile: deps.fs.writeFile.bind(deps.fs),
      appendFile: deps.fs.appendFile.bind(deps.fs),
      rename: deps.fs.rename.bind(deps.fs),
      mkdir: deps.fs.mkdir.bind(deps.fs),
      exists: deps.fs.exists.bind(deps.fs),
      glob: deps.fs.glob.bind(deps.fs),
      stat: deps.fs.stat.bind(deps.fs),
      remove: deps.fs.remove.bind(deps.fs),
      tempDir: deps.fs.tempDir.bind(deps.fs),
      symlink: deps.fs.symlink.bind(deps.fs),
      readDir: async (p: Path) => {
        readDirCalls += 1
        if (readDirCalls >= 3) {
          throw new Error('synthetic fs failure')
        }
        return deps.fs.readDir(p)
      },
    }

    const ctx: CaptureSessionIdContext = {
      cwd: WORK_CWD,
      fs: wrappedFs,
      clock: deps.clock,
      lock,
      timeoutMs: 5000,
    }
    const handle = runner.captureSessionId?.(ctx)
    await handle?.snapshotReady
    await flushPendingPolls()
    deps.clock.advance(100)

    expect(await handle?.result).toEqual({ error: 'error' })

    // Lock must be free again — acquiring directly after the failed capture
    // should resolve immediately rather than queue behind a stuck holder.
    const release = await Promise.race([
      lock.acquire(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('lock not released')), 100),
      ),
    ])
    release()
  })

  it('serializes two concurrent captures sharing one lock so the second snapshot waits for the first capture to complete', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lock = createCaptureLock()

    const events: string[] = []

    const first = runner.captureSessionId?.(makeCtx({ ...deps, lock }))
    const second = runner.captureSessionId?.(makeCtx({ ...deps, lock }))
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    first?.snapshotReady.then(() => events.push('first-snap'))
    second?.snapshotReady.then(() => events.push('second-snap'))
    first?.result.then(() => events.push('first-result'))
    second?.result.then(() => events.push('second-result'))

    // Drive first capture to a completion (timeout-as-empty is fine here —
    // what we care about is window ordering, not the result itself).
    await first?.snapshotReady
    await flushPendingPolls()
    deps.clock.advance(5000)
    await first?.result

    // Now the second capture should be able to take its snapshot and run.
    await second?.snapshotReady
    await flushPendingPolls()
    deps.clock.advance(5000)
    await second?.result

    // Critical ordering: first-snap and first-result both fire before
    // second-snap. The lock prevented second from snapshotting concurrently.
    expect(events.indexOf('first-snap')).toBeLessThan(events.indexOf('second-snap'))
    expect(events.indexOf('first-result')).toBeLessThan(events.indexOf('second-snap'))
  })

  it('does not serialize captures across two independent lock instances', async () => {
    const deps = makeCodexDeps()
    await deps.fs.mkdir(path(TODAY_DIR), { recursive: true })
    const runner = codex({}, { fs: deps.fs, ps: deps.ps })
    const lockA = createCaptureLock()
    const lockB = createCaptureLock()

    const events: string[] = []

    const first = runner.captureSessionId?.(makeCtx({ ...deps, lock: lockA }))
    const second = runner.captureSessionId?.(makeCtx({ ...deps, lock: lockB }))

    first?.snapshotReady.then(() => events.push('first-snap'))
    second?.snapshotReady.then(() => events.push('second-snap'))

    await Promise.all([first?.snapshotReady, second?.snapshotReady])

    // Both snapshots should be observable concurrently — neither call held
    // the other's lock.
    expect(events).toContain('first-snap')
    expect(events).toContain('second-snap')

    await flushPendingPolls()
    deps.clock.advance(5000)
    await Promise.all([first?.result, second?.result])
  })
})

describe('claude().captureSessionId', () => {
  it('is undefined because Claude pre-sets its session id via --session-id', () => {
    const runner = claude({})

    expect(typeof runner.captureSessionId).toBe('undefined')
  })
})
