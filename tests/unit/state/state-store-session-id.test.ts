import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-05-05-100000-z1' as RunId

function makeStore() {
  const fs = new FakeFsService()
  const store = new FileStateStore({ fs, basePath: BASE })
  return { fs, store }
}

describe('StepEntry.sessionId persistence (Phase 3)', () => {
  it('round-trips a step entry with sessionId set', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({ name: 'work-auth', mode: 'interactive', sessionId: 'sess-abc-123' }),
    )
    const state = await store.loadRun(RID)

    expect(state?.steps['work-auth']?.sessionId).toBe('sess-abc-123')
  })

  it('round-trips a step entry with sessionId absent (no null drift)', async () => {
    const { fs, store } = makeStore()

    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(RID, makeStepEntry({ name: 'autonomous-step' }))
    const raw = await fs.readFile(path(`/runs/${RID}/state.json`))

    expect(raw).not.toContain('sessionId')
    const reloaded = await store.loadRun(RID)
    expect(reloaded?.steps['autonomous-step']?.sessionId).toBeUndefined()
  })

  it('loads a pre-Phase-3 v5 state file (no sessionId key) cleanly', async () => {
    const { fs, store } = makeStore()

    // Hand-write a state file shaped exactly like the existing v5 fixture, no
    // sessionId key — proves additive schema change is non-breaking.
    const legacy = {
      schemaVersion: 5,
      id: RID,
      status: 'running',
      startedAt: 0,
      steps: {
        'old-interactive': {
          name: 'old-interactive',
          value: { exitCode: 0, durationMs: 100, sessionId: 'inner-id' },
          startedAt: 0,
          endedAt: 100,
          artifacts: [],
          validations: [],
          mode: 'interactive',
          transcriptEventCount: 0,
          transcriptTruncated: false,
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(legacy))

    const state = await store.loadRun(RID)

    expect(state?.schemaVersion).toBe(5)
    expect(state?.steps['old-interactive']).toBeDefined()
    expect(state?.steps['old-interactive']?.sessionId).toBeUndefined()
  })

  it('rejects an empty-string sessionId at schema-validation time', async () => {
    const { fs, store } = makeStore()

    const corrupt = {
      schemaVersion: 5,
      id: RID,
      status: 'running',
      startedAt: 0,
      steps: {
        bad: {
          name: 'bad',
          value: null,
          startedAt: 0,
          endedAt: 1,
          artifacts: [],
          validations: [],
          transcriptEventCount: 0,
          transcriptTruncated: false,
          sessionId: '',
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(corrupt))

    await expect(store.loadRun(RID)).rejects.toThrow()
  })
})
