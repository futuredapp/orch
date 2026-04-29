import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId, StateCorruptionError } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-04-10-458000-q8' as RunId

function makeStore() {
  const fs = new FakeFsService()
  const store = new FileStateStore({ fs, basePath: BASE })
  return { fs, store }
}

async function writeRawState(fs: FakeFsService, body: unknown): Promise<void> {
  await fs.mkdir(path('/runs/r-2026-04-10-458000-q8'), { recursive: true })
  await fs.writeFile(path('/runs/r-2026-04-10-458000-q8/state.json'), JSON.stringify(body))
}

describe('RunState schema v5', () => {
  it('round-trips a v5 state file with all current fields', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'deploy', startedAt: 5000 })
    const state = await store.loadRun(RID)

    expect(state).toBeDefined()
    expect(state?.schemaVersion).toBe(5)
    expect(state?.workflowName).toBe('deploy')
    expect(state?.startedAt).toBe(5000)
    expect(state?.endedAt).toBeUndefined()
    expect(state?.status).toBe('running')
  })

  it('setStatus writes endedAt on terminal states', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'test', startedAt: 1000 })
    await store.setStatus(RID, 'completed', 5000)
    const state = await store.loadRun(RID)

    expect(state?.status).toBe('completed')
    expect(state?.endedAt).toBe(5000)
  })

  it('setStatus without endedAt does not add the field', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 1000 })
    await store.setStatus(RID, 'crashed')
    const state = await store.loadRun(RID)

    expect(state?.status).toBe('crashed')
    expect(state?.endedAt).toBeUndefined()
  })

  it('initRun without meta uses defaults', async () => {
    const { store } = makeStore()

    await store.initRun(RID)
    const state = await store.loadRun(RID)

    expect(state?.schemaVersion).toBe(5)
    expect(state?.workflowName).toBeUndefined()
    expect(state?.startedAt).toBe(0)
  })

  it('saveStep preserves v5 fields through a write cycle', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'pipeline', startedAt: 1000 })
    await store.saveStep(RID, makeStepEntry({ name: 'step-a' }))
    const state = await store.loadRun(RID)

    expect(state?.workflowName).toBe('pipeline')
    expect(state?.startedAt).toBe(1000)
    expect(state?.steps['step-a']).toBeDefined()
    expect(state?.steps['step-a']?.transcriptEventCount).toBe(0)
    expect(state?.steps['step-a']?.transcriptTruncated).toBe(false)
  })

  it('initRun persists args when supplied', async () => {
    const { store } = makeStore()

    await store.initRun(RID, {
      workflowName: 'brainstorm',
      startedAt: 1000,
      args: { prompt: 'think hard' },
    })
    const state = await store.loadRun(RID)

    expect(state?.args).toEqual({ prompt: 'think hard' })
  })

  it('initRun omits args when not supplied', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'brainstorm', startedAt: 1000 })
    const state = await store.loadRun(RID)

    expect(state?.args).toBeUndefined()
  })

  it('initRun persists empty-string prompt as distinct from undefined', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 1000, args: { prompt: '' } })
    const state = await store.loadRun(RID)

    expect(state?.args).toEqual({ prompt: '' })
  })

  it('setArgs overwrites persisted args on an existing run', async () => {
    const { store } = makeStore()

    await store.initRun(RID, {
      workflowName: 'brainstorm',
      startedAt: 1000,
      args: { prompt: 'original' },
    })
    await store.setArgs(RID, { prompt: 'updated' })
    const state = await store.loadRun(RID)

    expect(state?.args).toEqual({ prompt: 'updated' })
  })

  it('setArgs throws when the run does not exist', async () => {
    const { store } = makeStore()

    await expect(store.setArgs(RID, { prompt: 'x' })).rejects.toThrow(/does not exist/)
  })

  it('saveStep preserves args across write cycles', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 1000, args: { prompt: 'keep me' } })
    await store.saveStep(RID, makeStepEntry({ name: 'step-a' }))
    const state = await store.loadRun(RID)

    expect(state?.args).toEqual({ prompt: 'keep me' })
  })

  it('setStatus preserves args', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 1000, args: { prompt: 'keep me' } })
    await store.setStatus(RID, 'completed', 2000)
    const state = await store.loadRun(RID)

    expect(state?.args).toEqual({ prompt: 'keep me' })
  })
})

describe('RunState pre-v5 rejection (prerelease — no migrations)', () => {
  it('rejects a v1 state file with wipe hint', async () => {
    const { fs, store } = makeStore()
    await writeRawState(fs, {
      schemaVersion: 1,
      id: 'r-2026-04-10-458000-q8',
      status: 'running',
      steps: {},
    })

    try {
      await store.loadRun(RID)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError)
      expect((err as Error).message).toContain('unsupported schema version')
      expect((err as Error).message).toContain('Wipe .orch/state/')
    }
  })

  it('rejects a v2 state file with wipe hint', async () => {
    const { fs, store } = makeStore()
    await writeRawState(fs, {
      schemaVersion: 2,
      id: 'r-2026-04-10-458000-q8',
      status: 'running',
      steps: {},
    })

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })

  it('rejects a v3 state file with wipe hint', async () => {
    const { fs, store } = makeStore()
    await writeRawState(fs, {
      schemaVersion: 3,
      id: 'r-2026-04-10-458000-q8',
      status: 'running',
      workflowName: 'deploy',
      startedAt: 5000,
      steps: {},
    })

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })

  it('rejects a v4 state file with wipe hint', async () => {
    const { fs, store } = makeStore()
    await writeRawState(fs, {
      schemaVersion: 4,
      id: 'r-2026-04-10-458000-q8',
      status: 'running',
      startedAt: 5000,
      steps: {},
    })

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })

  it('rejects unknown schemaVersion with StateCorruptionError', async () => {
    const { fs, store } = makeStore()
    await writeRawState(fs, {
      schemaVersion: 99,
      id: 'r-2026-04-10-458000-q8',
      status: 'running',
      steps: {},
    })

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })
})
