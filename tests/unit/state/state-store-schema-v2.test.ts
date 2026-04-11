import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import {
  FileStateStore,
  type RunId,
  StateCorruptionError,
  StepEntrySchema,
} from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-04-10-000001' as RunId

describe('StepEntrySchema v2', () => {
  it('rejects a v1 state file with an actionable StateCorruptionError', async () => {
    const fs = new FakeFsService()
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
    const store = new FileStateStore({ fs, basePath: BASE })

    try {
      await store.loadRun(RID)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(StateCorruptionError)
      expect((err as Error).message).toContain('Phase 6 bumped to v2')
      expect((err as Error).message).toContain('delete .orch/state/')
    }
  })

  it('rejects a poisoned preRunSnapshot.headSha with a non-hex value', async () => {
    const fs = new FakeFsService()
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
            value: null,
            startedAt: 0,
            endedAt: 1,
            artifacts: [],
            preRunSnapshot: { headSha: '--upload-pack=/tmp/evil' },
            validations: [],
          },
        },
      }),
    )
    const store = new FileStateStore({ fs, basePath: BASE })

    await expect(store.loadRun(RID)).rejects.toBeInstanceOf(StateCorruptionError)
  })

  it('accepts a well-formed preRunSnapshot.headSha through a round-trip', async () => {
    const fs = new FakeFsService()
    const store = new FileStateStore({ fs, basePath: BASE })
    const entry = makeStepEntry({
      name: 'plan',
      preRunSnapshot: { headSha: 'abcdef1234567890' },
    })

    await store.saveStep(RID, entry)
    const state = await store.loadRun(RID)

    expect(state?.steps.plan?.preRunSnapshot?.headSha).toBe('abcdef1234567890')
  })

  it('preserves validations through a save-then-load round trip', async () => {
    const fs = new FakeFsService()
    const store = new FileStateStore({ fs, basePath: BASE })
    const entry = makeStepEntry({
      name: 'plan',
      validations: [
        { name: 'fileProduced(*.md)', ok: true },
        {
          name: 'gitDiffCreated',
          ok: false,
          reason: 'no diff since baseline',
          hint: 'did the step edit anything?',
        },
      ],
    })

    await store.saveStep(RID, entry)
    const state = await store.loadRun(RID)

    expect(state?.steps.plan?.validations).toEqual([
      { name: 'fileProduced(*.md)', ok: true },
      {
        name: 'gitDiffCreated',
        ok: false,
        reason: 'no diff since baseline',
        hint: 'did the step edit anything?',
      },
    ])
  })

  it('copies every StepEntrySchema key through the loader (structural round-trip guard)', async () => {
    const fs = new FakeFsService()
    const store = new FileStateStore({ fs, basePath: BASE })
    const entry = makeStepEntry({
      name: 'plan',
      preRunSnapshot: { headSha: 'deadbeefcafe1234' },
      validations: [{ name: 'x', ok: true }],
    })

    await store.saveStep(RID, entry)
    const state = await store.loadRun(RID)
    const decoded = state?.steps.plan

    for (const key of Object.keys(StepEntrySchema.shape)) {
      expect(decoded).toHaveProperty(key)
    }
  })
})
