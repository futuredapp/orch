import { describe, expect, it } from 'bun:test'
import { FakeFsService, type FsService, type Path, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId, runId, type StepEntry } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const rid = (s: string): RunId => runId(s)

const BASE = path('/runs')

function makeStore(fs?: FsService): { store: FileStateStore; fs: FsService } {
  const fakeFs = fs ?? new FakeFsService()
  const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
  return { store, fs: fakeFs }
}

const makeEntry = (overrides: Partial<StepEntry> = {}): StepEntry => makeStepEntry(overrides)

/**
 * Thin recording fake that tracks every writeFile call by path. Lets tests
 * observe tmp-file naming without mocking internal modules. Delegates reads
 * and rename to an underlying FakeFsService.
 */
class RecordingFsService implements FsService {
  readonly inner: FakeFsService
  readonly writes: Path[] = []

  constructor() {
    this.inner = new FakeFsService()
  }

  readFile(p: Path): Promise<string> {
    return this.inner.readFile(p)
  }

  async writeFile(p: Path, data: string): Promise<void> {
    this.writes.push(p)
    await this.inner.writeFile(p, data)
  }

  appendFile(p: Path, data: string): Promise<void> {
    return this.inner.appendFile(p, data)
  }

  rename(from: Path, to: Path): Promise<void> {
    return this.inner.rename(from, to)
  }

  mkdir(p: Path, opts?: { readonly recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(p, opts)
  }

  exists(p: Path): Promise<boolean> {
    return this.inner.exists(p)
  }

  glob(pattern: string, opts?: { readonly cwd?: Path }): AsyncIterable<Path> {
    return this.inner.glob(pattern, opts)
  }

  readDir(p: Path): Promise<readonly Path[]> {
    return this.inner.readDir(p)
  }

  stat(p: Path): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    return this.inner.stat(p)
  }

  remove(p: Path): Promise<void> {
    return this.inner.remove(p)
  }

  tempDir(prefix: string): Promise<Path> {
    return this.inner.tempDir(prefix)
  }
}

describe('FileStateStore', () => {
  it('loadRun returns undefined for a non-existent run', async () => {
    const { store } = makeStore()

    const result = await store.loadRun(rid('r-2026-04-10-ab0000'))

    expect(result).toBeUndefined()
  })

  it('saveStep then loadRun round-trips a single step entry', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')
    const entry = makeEntry()

    await store.saveStep(id, entry)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(state?.id).toBe(id)
    expect(state?.schemaVersion).toBe(5)
    expect(state?.status).toBe('running')
    expect(state?.steps['step-a']).toEqual(entry)
  })

  it('saveStep then loadRun round-trips multiple step entries', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')
    const entryA = makeEntry({ name: 'step-a' })
    const entryB = makeEntry({ name: 'step-b', value: 42, startedAt: 3000, endedAt: 4000 })

    await store.saveStep(id, entryA)
    await store.saveStep(id, entryB)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(Object.keys(state?.steps ?? {})).toHaveLength(2)
    expect(state?.steps['step-a']).toEqual(entryA)
    expect(state?.steps['step-b']).toEqual(entryB)
  })

  it('saveStep overwrites an existing step with the same name', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')
    const original = makeEntry({ name: 'step-a', value: 'first' })
    const updated = makeEntry({ name: 'step-a', value: 'second' })

    await store.saveStep(id, original)
    await store.saveStep(id, updated)
    const state = await store.loadRun(id)

    expect(state?.steps['step-a']?.value).toBe('second')
  })

  it('saveStep creates the run directory if it does not exist', async () => {
    const { store, fs } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.saveStep(id, makeEntry())

    expect(await fs.exists(path('/runs/r-2026-04-10-000001'))).toBe(true)
  })

  it('loadRun throws StateCorruptionError on corrupted JSON', async () => {
    const fakeFs = new FakeFsService()
    await fakeFs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fakeFs.writeFile(path('/runs/r-2026-04-10-000001/state.json'), '{ broken json')
    const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
    const id = rid('r-2026-04-10-000001')

    expect(store.loadRun(id)).rejects.toThrow()
  })

  it('atomic write leaves original state untouched when rename fails', async () => {
    const fakeFs = new FakeFsService()
    const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
    const id = rid('r-2026-04-10-000001')

    await store.saveStep(id, makeEntry({ name: 'original', value: 'safe' }))

    const originalJson = await fakeFs.readFile(path('/runs/r-2026-04-10-000001/state.json'))

    // Inject a failing rename — applied after the first successful save
    fakeFs.rename = async () => {
      throw new Error('Simulated rename failure')
    }

    await expect(
      store.saveStep(id, makeEntry({ name: 'bad-step', value: 'danger' })),
    ).rejects.toThrow('Simulated rename failure')

    const afterJson = await fakeFs.readFile(path('/runs/r-2026-04-10-000001/state.json'))
    expect(afterJson).toBe(originalJson)
  })

  it('saveStep wraps JSON.stringify errors with step name and cause', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const entry = makeEntry({ name: 'bad-value', value: circular })

    try {
      await store.saveStep(id, entry)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('bad-value')
    }
  })

  it('initRun creates an empty running state', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.initRun(id)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(state?.id).toBe(id)
    expect(state?.schemaVersion).toBe(5)
    expect(state?.status).toBe('running')
    expect(state?.steps).toEqual({})
  })

  it('initRun is idempotent — calling twice does not clear existing steps', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.initRun(id)
    await store.saveStep(id, makeEntry({ name: 'step-a' }))
    await store.initRun(id)
    const state = await store.loadRun(id)

    expect(state?.steps['step-a']).toBeDefined()
    expect(Object.keys(state?.steps ?? {})).toHaveLength(1)
  })

  it('setStatus transitions status from running to completed', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.initRun(id)
    await store.setStatus(id, 'completed')
    const state = await store.loadRun(id)

    expect(state?.status).toBe('completed')
  })

  it('setStatus transitions status from running to crashed', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.initRun(id)
    await store.setStatus(id, 'crashed')
    const state = await store.loadRun(id)

    expect(state?.status).toBe('crashed')
  })

  it('setStatus throws for a non-existent run', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    expect(store.setStatus(id, 'completed')).rejects.toThrow('does not exist')
  })

  it('loadRun rethrows EACCES errors instead of returning undefined', async () => {
    const fakeFs = new FakeFsService()
    const eaccesError: Error & { code?: string } = new Error('EACCES: permission denied')
    eaccesError.code = 'EACCES'
    fakeFs.readFile = async () => {
      throw eaccesError
    }
    const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
    const id = rid('r-2026-04-10-000001')

    await expect(store.loadRun(id)).rejects.toThrow('EACCES: permission denied')
  })

  it('saveStep cleans up its .tmp file when the rename step fails', async () => {
    const recording = new RecordingFsService()
    const store = new FileStateStore({ fs: recording, basePath: BASE })
    const id = rid('r-2026-04-10-000001')

    recording.rename = async () => {
      throw new Error('Simulated rename failure')
    }

    await expect(store.saveStep(id, makeEntry())).rejects.toThrow('Simulated rename failure')

    const tmpWrites = recording.writes.filter((p) => p.endsWith('.tmp'))
    expect(tmpWrites).toHaveLength(1)
    const tmpPath = tmpWrites[0]
    expect(tmpPath).toBeDefined()
    if (tmpPath) {
      expect(await recording.inner.exists(tmpPath)).toBe(false)
    }
  })

  it('saveStep uses a unique tmp path per invocation', async () => {
    const recording = new RecordingFsService()
    const store = new FileStateStore({ fs: recording, basePath: BASE })
    const id = rid('r-2026-04-10-000001')

    await store.saveStep(id, makeEntry({ name: 'step-a' }))
    await store.saveStep(id, makeEntry({ name: 'step-b' }))
    await store.saveStep(id, makeEntry({ name: 'step-c' }))

    const tmpWrites = recording.writes.filter((p) => p.endsWith('.tmp'))
    const uniqueTmpWrites = new Set(tmpWrites)
    expect(tmpWrites).toHaveLength(3)
    expect(uniqueTmpWrites.size).toBe(3)
  })

  it('loadRun returns a branded RunId, not a raw string', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.saveStep(id, makeEntry())
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    if (state) {
      // Compile-time assertion: assigning to RunId without a cast only type-checks
      // if state.id is already branded. A raw string would fail `strict` mode.
      const branded: RunId = state.id
      expect(branded).toBe(id)
    }
  })

  it('concurrent saveStep calls for the same runId do not lose entries', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await Promise.all([
      store.saveStep(id, makeEntry({ name: 'step-a', value: 'a' })),
      store.saveStep(id, makeEntry({ name: 'step-b', value: 'b' })),
      store.saveStep(id, makeEntry({ name: 'step-c', value: 'c' })),
    ])
    const state = await store.loadRun(id)

    expect(Object.keys(state?.steps ?? {})).toHaveLength(3)
    expect(state?.steps['step-a']?.value).toBe('a')
    expect(state?.steps['step-b']?.value).toBe('b')
    expect(state?.steps['step-c']?.value).toBe('c')
  })

  it('concurrent saveStep calls for different runIds do not interfere', async () => {
    const { store } = makeStore()
    const id1 = rid('r-2026-04-10-000001')
    const id2 = rid('r-2026-04-10-000002')

    await Promise.all([
      store.saveStep(id1, makeEntry({ name: 'step-x', value: 'x' })),
      store.saveStep(id2, makeEntry({ name: 'step-y', value: 'y' })),
    ])

    const state1 = await store.loadRun(id1)
    const state2 = await store.loadRun(id2)

    expect(Object.keys(state1?.steps ?? {})).toHaveLength(1)
    expect(state1?.steps['step-x']?.value).toBe('x')
    expect(Object.keys(state2?.steps ?? {})).toHaveLength(1)
    expect(state2?.steps['step-y']?.value).toBe('y')
  })

  it('write queue cleans up after chain goes idle', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-000001')

    await store.saveStep(id, makeEntry({ name: 'step-a' }))

    // After awaiting saveStep, the swallowed promise's cleanup microtask
    // fires and removes the idle entry from the write queue.
    // Yield a microtask tick to let the cleanup `.then()` run.
    await new Promise((resolve) => queueMicrotask(resolve))

    expect(store.writeQueueSize).toBe(0)
  })
})
