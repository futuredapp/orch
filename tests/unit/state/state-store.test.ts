import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId, type StepEntry } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

const BASE = path('/runs')

function makeStore(fs?: FakeFsService): { store: FileStateStore; fs: FakeFsService } {
  const fakeFs = fs ?? new FakeFsService()
  const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
  return { store, fs: fakeFs }
}

function makeEntry(overrides: Partial<StepEntry> = {}): StepEntry {
  return {
    name: 'step-a',
    value: { result: 'ok' },
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    ...overrides,
  }
}

describe('FileStateStore', () => {
  it('loadRun returns undefined for a non-existent run', async () => {
    const { store } = makeStore()

    const result = await store.loadRun(rid('r-2026-04-10-ab00'))

    expect(result).toBeUndefined()
  })

  it('saveStep then loadRun round-trips a single step entry', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')
    const entry = makeEntry()

    await store.saveStep(id, entry)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(state?.id).toBe(id)
    expect(state?.schemaVersion).toBe(1)
    expect(state?.status).toBe('running')
    expect(state?.steps['step-a']).toEqual(entry)
  })

  it('saveStep then loadRun round-trips multiple step entries', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')
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
    const id = rid('r-2026-04-10-0001')
    const original = makeEntry({ name: 'step-a', value: 'first' })
    const updated = makeEntry({ name: 'step-a', value: 'second' })

    await store.saveStep(id, original)
    await store.saveStep(id, updated)
    const state = await store.loadRun(id)

    expect(state?.steps['step-a']?.value).toBe('second')
  })

  it('saveStep creates the run directory if it does not exist', async () => {
    const { store, fs } = makeStore()
    const id = rid('r-2026-04-10-0001')

    await store.saveStep(id, makeEntry())

    expect(await fs.exists(path('/runs/r-2026-04-10-0001'))).toBe(true)
  })

  it('loadRun throws StateCorruptionError on corrupted JSON', async () => {
    const fakeFs = new FakeFsService()
    await fakeFs.mkdir(path('/runs/r-2026-04-10-0001'), { recursive: true })
    await fakeFs.writeFile(path('/runs/r-2026-04-10-0001/state.json'), '{ broken json')
    const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
    const id = rid('r-2026-04-10-0001')

    expect(store.loadRun(id)).rejects.toThrow()
  })

  it('atomic write leaves original state untouched when rename fails', async () => {
    const fakeFs = new FakeFsService()
    const store = new FileStateStore({ fs: fakeFs, basePath: BASE })
    const id = rid('r-2026-04-10-0001')

    await store.saveStep(id, makeEntry({ name: 'original', value: 'safe' }))

    const originalJson = await fakeFs.readFile(path('/runs/r-2026-04-10-0001/state.json'))

    // Inject a failing rename — applied after the first successful save
    fakeFs.rename = async () => {
      throw new Error('Simulated rename failure')
    }

    await expect(
      store.saveStep(id, makeEntry({ name: 'bad-step', value: 'danger' })),
    ).rejects.toThrow('Simulated rename failure')

    const afterJson = await fakeFs.readFile(path('/runs/r-2026-04-10-0001/state.json'))
    expect(afterJson).toBe(originalJson)
  })

  it('saveStep wraps JSON.stringify errors with step name and cause', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')
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
    const id = rid('r-2026-04-10-0001')

    await store.initRun(id)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(state?.id).toBe(id)
    expect(state?.schemaVersion).toBe(1)
    expect(state?.status).toBe('running')
    expect(state?.steps).toEqual({})
  })

  it('initRun is idempotent — calling twice does not clear existing steps', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')

    await store.initRun(id)
    await store.saveStep(id, makeEntry({ name: 'step-a' }))
    await store.initRun(id)
    const state = await store.loadRun(id)

    expect(state?.steps['step-a']).toBeDefined()
    expect(Object.keys(state?.steps ?? {})).toHaveLength(1)
  })

  it('setStatus transitions status from running to completed', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')

    await store.initRun(id)
    await store.setStatus(id, 'completed')
    const state = await store.loadRun(id)

    expect(state?.status).toBe('completed')
  })

  it('setStatus transitions status from running to crashed', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')

    await store.initRun(id)
    await store.setStatus(id, 'crashed')
    const state = await store.loadRun(id)

    expect(state?.status).toBe('crashed')
  })

  it('setStatus throws for a non-existent run', async () => {
    const { store } = makeStore()
    const id = rid('r-2026-04-10-0001')

    expect(store.setStatus(id, 'completed')).rejects.toThrow('does not exist')
  })
})
