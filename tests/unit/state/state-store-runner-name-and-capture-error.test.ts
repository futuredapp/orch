// MIGRATED → tests-new/unit/state/state-store-runner-name-and-capture-error.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-05-13-100000-a1' as RunId

function makeStore() {
  const fs = new FakeFsService()
  const store = new FileStateStore({ fs, basePath: BASE })
  return { fs, store }
}

describe.skip('StepEntry.runnerName + sessionIdCaptureError persistence', () => {
  it('round-trips a step entry with sessionId, runnerName, and sessionIdCaptureError all set', async () => {
    const { store } = makeStore()

    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({
        name: 'work-codex',
        mode: 'interactive',
        sessionId: 'thread-xyz-789',
        runnerName: 'codex',
        sessionIdCaptureError: 'ambiguous',
      }),
    )
    const state = await store.loadRun(RID)

    expect(state?.steps['work-codex']?.sessionId).toBe('thread-xyz-789')
    expect(state?.steps['work-codex']?.runnerName).toBe('codex')
    expect(state?.steps['work-codex']?.sessionIdCaptureError).toBe('ambiguous')
  })

  it('round-trips a step entry with neither new field set (no null drift)', async () => {
    const { fs, store } = makeStore()

    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(RID, makeStepEntry({ name: 'autonomous-step' }))
    const raw = await fs.readFile(path(`/runs/${RID}/state.json`))

    expect(raw).not.toContain('runnerName')
    expect(raw).not.toContain('sessionIdCaptureError')
    const reloaded = await store.loadRun(RID)
    expect(reloaded?.steps['autonomous-step']?.runnerName).toBeUndefined()
    expect(reloaded?.steps['autonomous-step']?.sessionIdCaptureError).toBeUndefined()
  })

  it('loads a pre-feature v5 state file (no new keys) cleanly', async () => {
    const { fs, store } = makeStore()

    const legacy = {
      schemaVersion: 5,
      id: RID,
      status: 'running',
      startedAt: 0,
      steps: {
        'old-interactive': {
          name: 'old-interactive',
          value: { exitCode: 0, durationMs: 100 },
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

    expect(state?.steps['old-interactive']).toBeDefined()
    expect(state?.steps['old-interactive']?.runnerName).toBeUndefined()
    expect(state?.steps['old-interactive']?.sessionIdCaptureError).toBeUndefined()
  })

  it('accepts all three valid sessionIdCaptureError enum values', async () => {
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })

    for (const tag of ['ambiguous', 'empty', 'error'] as const) {
      await store.saveStep(
        RID,
        makeStepEntry({
          name: `step-${tag}`,
          mode: 'interactive',
          runnerName: 'codex',
          sessionIdCaptureError: tag,
        }),
      )
    }
    const state = await store.loadRun(RID)

    expect(state?.steps['step-ambiguous']?.sessionIdCaptureError).toBe('ambiguous')
    expect(state?.steps['step-empty']?.sessionIdCaptureError).toBe('empty')
    expect(state?.steps['step-error']?.sessionIdCaptureError).toBe('error')
  })

  it('rejects an unknown sessionIdCaptureError value at schema-validation time', async () => {
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
          sessionIdCaptureError: 'unknown-value',
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(corrupt))

    await expect(store.loadRun(RID)).rejects.toThrow()
  })

  it('rejects an empty-string runnerName at schema-validation time', async () => {
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
          runnerName: '',
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(corrupt))

    await expect(store.loadRun(RID)).rejects.toThrow()
  })
})
