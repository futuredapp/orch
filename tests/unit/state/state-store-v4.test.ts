import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId, StateCorruptionError } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-04-10-000001' as RunId

function makeStore() {
  const fs = new FakeFsService()
  const store = new FileStateStore({ fs, basePath: BASE })
  return { fs, store }
}

describe('RunState schema v3', () => {
  it('round-trips a v3 state file with all new fields', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'deploy', startedAt: 5000 })
    const state = await store.loadRun(RID)

    expect(state).toBeDefined()
    expect(state?.schemaVersion).toBe(3)
    expect(state?.workflowName).toBe('deploy')
    expect(state?.startedAt).toBe(5000)
    expect(state?.endedAt).toBeUndefined()
    expect(state?.status).toBe('running')
  })

  it('reads a v2 state file on disk and transforms it to v3 in memory', async () => {
    const { fs, store } = makeStore()

    // Write a raw v2 state file
    await fs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fs.writeFile(
      path('/runs/r-2026-04-10-000001/state.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'r-2026-04-10-000001',
        status: 'running',
        steps: {
          'step-a': {
            name: 'step-a',
            value: 'a',
            startedAt: 100,
            endedAt: 200,
            artifacts: [],
            validations: [],
          },
          'step-b': {
            name: 'step-b',
            value: 'b',
            startedAt: 300,
            endedAt: 400,
            artifacts: [],
            validations: [],
          },
        },
      }),
    )

    const state = await store.loadRun(RID)

    expect(state?.schemaVersion).toBe(3)
    expect(state?.workflowName).toBeUndefined()
    expect(state?.startedAt).toBe(100) // min of step startedAt values
    expect(state?.endedAt).toBeUndefined()
    expect(state?.steps['step-a']?.value).toBe('a')
    expect(state?.steps['step-b']?.value).toBe('b')
  })

  it('v2 file is not rewritten to v3 on disk after a read', async () => {
    const { fs, store } = makeStore()

    const v2Json = JSON.stringify({
      schemaVersion: 2,
      id: 'r-2026-04-10-000001',
      status: 'completed',
      steps: {},
    })
    await fs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fs.writeFile(path('/runs/r-2026-04-10-000001/state.json'), v2Json)

    await store.loadRun(RID)

    const afterRead = await fs.readFile(path('/runs/r-2026-04-10-000001/state.json'))
    const parsed = JSON.parse(afterRead)
    expect(parsed.schemaVersion).toBe(2)
  })

  it('v2 file with zero steps produces startedAt = 0', async () => {
    const { fs, store } = makeStore()

    await fs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fs.writeFile(
      path('/runs/r-2026-04-10-000001/state.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'r-2026-04-10-000001',
        status: 'crashed',
        steps: {},
      }),
    )

    const state = await store.loadRun(RID)

    expect(state?.startedAt).toBe(0)
  })

  it('discriminator rejects unknown schemaVersion with StateCorruptionError', async () => {
    const { fs, store } = makeStore()

    await fs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fs.writeFile(
      path('/runs/r-2026-04-10-000001/state.json'),
      JSON.stringify({
        schemaVersion: 99,
        id: 'r-2026-04-10-000001',
        status: 'running',
        steps: {},
      }),
    )

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })

  it('discriminator rejects schemaVersion 1 with unsupported version message', async () => {
    const { fs, store } = makeStore()

    await fs.mkdir(path('/runs/r-2026-04-10-000001'), { recursive: true })
    await fs.writeFile(
      path('/runs/r-2026-04-10-000001/state.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'r-2026-04-10-000001',
        status: 'running',
        steps: {},
      }),
    )

    try {
      await store.loadRun(RID)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError)
      expect((err as Error).message).toContain('unsupported schema version')
    }
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

    expect(state?.schemaVersion).toBe(3)
    expect(state?.workflowName).toBeUndefined()
    expect(state?.startedAt).toBe(0)
  })

  it('saveStep preserves v3 fields through write cycle', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { workflowName: 'pipeline', startedAt: 1000 })
    await store.saveStep(RID, makeStepEntry({ name: 'step-a' }))
    const state = await store.loadRun(RID)

    expect(state?.workflowName).toBe('pipeline')
    expect(state?.startedAt).toBe(1000)
    expect(state?.steps['step-a']).toBeDefined()
  })
})
