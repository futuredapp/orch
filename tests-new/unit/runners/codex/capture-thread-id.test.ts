import { describe, expect, it } from 'bun:test'
import {
  captureCodexThreadId,
  resolveCodexSessionsRoot,
} from '../../../../src/runners/codex/capture-thread-id.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import type { FsService } from '../../../../src/services/fs/fs-service.ts'
import { type Path, path } from '../../../../src/services/types.ts'

// 2026-05-13T12:00:00Z — fixed so dir paths are deterministic.
const FIXED_EPOCH = Date.UTC(2026, 4, 13, 12, 0, 0)
const TODAY_DIR = '/codex/2026/05/13'
const TOMORROW_DIR = '/codex/2026/05/14'

const SESSIONS_ROOT = path('/codex')
const WORK_CWD = path('/work')

function sessionMetaLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'session_meta', payload })
}

async function seedDir(fs: FakeFsService, dir: Path): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

// Flush the microtask queue to a known point: after every pending readDir /
// readFile continuation in the helper has run. The helper's poll loop awaits
// `clock.sleep(...)` between iterations — a `setImmediate`-backed yield from
// the test side guarantees the next sleep has been registered before we call
// `clock.advance(...)` to wake it. Without this barrier, tests advance the
// clock first and the helper queues its sleep at a dueAt the test never
// reaches, causing a deterministic timeout.
function flushPendingPolls(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('captureCodexThreadId', () => {
  it('resolves snapshotReady before the first new file can appear and then yields the matching sessionId', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))
    await fs.writeFile(
      path(`${TODAY_DIR}/A.jsonl`),
      sessionMetaLine({ id: 'old', cwd: '/elsewhere' }),
    )

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      sessionMetaLine({ id: 'new-id', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    clock.advance(100)

    expect(await result).toEqual({ sessionId: 'new-id' })
  })

  it('returns ambiguous when two new rollouts have a cwd matching the workflow cwd', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(path(`${TODAY_DIR}/B.jsonl`), sessionMetaLine({ id: 'one', cwd: WORK_CWD }))
    await fs.writeFile(path(`${TODAY_DIR}/C.jsonl`), sessionMetaLine({ id: 'two', cwd: WORK_CWD }))
    await flushPendingPolls()
    clock.advance(100)

    expect(await result).toEqual({ error: 'ambiguous' })
  })

  it('returns empty when no new rollout appears before the timeout fires', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))
    await fs.writeFile(path(`${TODAY_DIR}/A.jsonl`), sessionMetaLine({ id: 'old', cwd: WORK_CWD }))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady
    await flushPendingPolls()

    clock.advance(5000)

    expect(await result).toEqual({ error: 'empty' })
  })

  it('returns error when the underlying fs throws unexpectedly mid-poll', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    let readDirCalls = 0
    const fsWrapper: FsService = {
      readFile: fs.readFile.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      appendFile: fs.appendFile.bind(fs),
      rename: fs.rename.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      exists: fs.exists.bind(fs),
      glob: fs.glob.bind(fs),
      stat: fs.stat.bind(fs),
      remove: fs.remove.bind(fs),
      tempDir: fs.tempDir.bind(fs),
      symlink: fs.symlink.bind(fs),
      readDir: async (p: Path) => {
        readDirCalls += 1
        if (readDirCalls >= 3) {
          throw new Error('synthetic readdir failure')
        }
        return fs.readDir(p)
      },
    }

    const { snapshotReady, result } = captureCodexThreadId({
      fs: fsWrapper,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady
    await flushPendingPolls()
    clock.advance(100)

    expect(await result).toEqual({ error: 'error' })
  })

  it('keeps polling and returns empty when a new rollout has a non-matching cwd', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(
      path(`${TODAY_DIR}/X.jsonl`),
      sessionMetaLine({ id: 'someone-else', cwd: '/other/project' }),
    )
    await flushPendingPolls()

    clock.advance(5000)

    expect(await result).toEqual({ error: 'empty' })
  })

  it('treats a session_meta payload missing payload.id as not-ready and times out as empty', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { cwd: WORK_CWD } }),
    )
    await flushPendingPolls()

    clock.advance(5000)

    expect(await result).toEqual({ error: 'empty' })
  })

  it('treats a malformed first line as not-ready and times out as empty when the file never becomes parseable', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(path(`${TODAY_DIR}/B.jsonl`), '{not json')
    await flushPendingPolls()

    clock.advance(5000)

    expect(await result).toEqual({ error: 'empty' })
  })

  it('keeps retrying an unparseable file across iterations and succeeds once it parses', async () => {
    // The helper marks files as "processed" only after a successful parse with
    // matching shape. An empty / malformed file stays in the retry set so the
    // next iteration re-reads it. We drive this by swapping the file content
    // between fake-fs writes across two clock.advance() calls.
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await fs.writeFile(path(`${TODAY_DIR}/B.jsonl`), '{not yet')
    await flushPendingPolls()
    clock.advance(100)
    await flushPendingPolls()

    await fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      sessionMetaLine({ id: 'recovered', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    clock.advance(100)

    expect(await result).toEqual({ sessionId: 'recovered' })
  })

  it('captures a rollout whose first session_meta line lands ~9s after the empty file appears (the codex 0.130 timing)', async () => {
    // Regression for docs/handovers/2026-05-18-codex-capture-empty-timeout-handover.md.
    // Codex 0.130 creates the rollout file at spawn but does not write the first
    // session_meta line until after the model's first response — observed at
    // ~9s on a real interactive run, well past the original 5s default. The
    // default timeout was bumped to 60s so this real-world timeline succeeds
    // WITHOUT the caller supplying its own `timeoutMs`. The test deliberately
    // omits `timeoutMs` so a future regression that re-lowers the default below
    // ~10s breaks this case.
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      intervalMs: 1000,
    })

    await snapshotReady

    // Codex creates the rollout file at spawn — but empty. The helper sees the
    // file each iteration, reads 0 bytes, treats it as not-ready, and keeps
    // polling.
    await fs.writeFile(path(`${TODAY_DIR}/rollout.jsonl`), '')

    // Burn 9 simulated seconds of empty-file polling — i.e. 4 seconds past the
    // previous 5s default. A revert to that default would have timed out here.
    for (let i = 0; i < 9; i++) {
      await flushPendingPolls()
      clock.advance(1000)
    }

    // ~9s in: Codex finally flushes the first session_meta line.
    await fs.writeFile(
      path(`${TODAY_DIR}/rollout.jsonl`),
      sessionMetaLine({ id: '019e3aa7-aff3-73e0-a2ea-c87f164f9637', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    clock.advance(1000)

    expect(await result).toEqual({ sessionId: '019e3aa7-aff3-73e0-a2ea-c87f164f9637' })
  })

  it('uses a default timeout long enough to survive >5s of an empty rollout file', async () => {
    // Direct pin on the default timeout value. If the default ever regresses
    // back below 6s, the slow-write test above would still fail — but this
    // test fails first and names the cause: the default itself.
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      intervalMs: 1000,
    })

    await snapshotReady
    await fs.writeFile(path(`${TODAY_DIR}/rollout.jsonl`), '')

    // 6 simulated seconds of empty-file polling — one full second past the
    // previous 5s default. Content arrives on the 7th tick.
    for (let i = 0; i < 6; i++) {
      await flushPendingPolls()
      clock.advance(1000)
    }

    await fs.writeFile(
      path(`${TODAY_DIR}/rollout.jsonl`),
      sessionMetaLine({ id: 'past-old-default', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    clock.advance(1000)

    expect(await result).toEqual({ sessionId: 'past-old-default' })
  })

  it("resolves snapshotReady when today's sessions directory does not yet exist and then captures the new file", async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady

    await seedDir(fs, path(TODAY_DIR))
    await fs.writeFile(
      path(`${TODAY_DIR}/B.jsonl`),
      sessionMetaLine({ id: 'first', cwd: WORK_CWD }),
    )
    await flushPendingPolls()
    clock.advance(100)

    expect(await result).toEqual({ sessionId: 'first' })
  })

  it("watches tomorrow's directory so a rollout that lands after midnight is still captured", async () => {
    // 23:59:58 UTC — capture window crosses into the next UTC day.
    const start = Date.UTC(2026, 4, 13, 23, 59, 58)
    const clock = new FakeClock(start)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 10_000,
      intervalMs: 100,
    })

    await snapshotReady

    await seedDir(fs, path(TOMORROW_DIR))
    await fs.writeFile(
      path(`${TOMORROW_DIR}/post-midnight.jsonl`),
      sessionMetaLine({ id: 'across-midnight', cwd: WORK_CWD }),
    )
    await flushPendingPolls()

    clock.advance(3000)

    expect(await result).toEqual({ sessionId: 'across-midnight' })
  })

  it('returns error immediately when sessionsRoot resolution fails (no env override and no homedir)', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: undefined,
      timeoutMs: 5000,
      intervalMs: 100,
    })

    await snapshotReady
    expect(await result).toEqual({ error: 'error' })
  })

  it('returns empty as soon as an AbortSignal fires before the next iteration', async () => {
    const clock = new FakeClock(FIXED_EPOCH)
    const fs = new FakeFsService({ clock })
    await seedDir(fs, path(TODAY_DIR))

    const controller = new AbortController()

    const { snapshotReady, result } = captureCodexThreadId({
      fs,
      clock,
      cwd: WORK_CWD,
      sessionsRoot: SESSIONS_ROOT,
      timeoutMs: 5000,
      intervalMs: 100,
      signal: controller.signal,
    })

    await snapshotReady
    await flushPendingPolls()

    controller.abort()
    clock.advance(100)

    expect(await result).toEqual({ error: 'empty' })
  })
})

describe('resolveCodexSessionsRoot', () => {
  it('returns the ORCH_CODEX_SESSIONS_ROOT override when set to a non-empty value', () => {
    const root = resolveCodexSessionsRoot({
      envOverride: '/custom/codex',
      homedir: '/home/user',
    })

    expect(root).toBe('/custom/codex' as Path)
  })

  it('falls back to homedir + /.codex/sessions when the env override is absent', () => {
    const root = resolveCodexSessionsRoot({
      envOverride: undefined,
      homedir: '/home/user',
    })

    expect(root).toBe('/home/user/.codex/sessions' as Path)
  })

  it('treats an empty env override as absent', () => {
    const root = resolveCodexSessionsRoot({
      envOverride: '',
      homedir: '/home/user',
    })

    expect(root).toBe('/home/user/.codex/sessions' as Path)
  })

  it('returns undefined when neither the env override nor homedir yields a usable path', () => {
    const root = resolveCodexSessionsRoot({
      envOverride: undefined,
      homedir: '',
    })

    expect(root).toBeUndefined()
  })
})
