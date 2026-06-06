// MIGRATED → tests-new/unit/state/state-store-subpath.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U7 — `StepEntry.subPath` persistence (also covers U4 `subCallId` and U9
// `insideParallel`). All three are additive, optional fields with no
// schemaVersion bump; pre-feature state files load with each undefined.

import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-05-28-100002-a1' as RunId

function makeStore() {
  const fs = new FakeFsService()
  const store = new FileStateStore({ fs, basePath: BASE })
  return { fs, store }
}

describe.skip('StepEntry.subPath persistence', () => {
  it('round-trips an entry with subPath set to a single-level chain', async () => {
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({
        name: 'simple-feature>plan',
        subPath: ['simple-feature'],
        subCallId: 'call-1',
      }),
    )

    const state = await store.loadRun(RID)

    expect(state?.steps['simple-feature>plan']?.subPath).toEqual(['simple-feature'])
    expect(state?.steps['simple-feature>plan']?.subCallId).toBe('call-1')
  })

  it('round-trips an entry with subPath set to a nested chain', async () => {
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({
        name: 'outer>inner>plan',
        subPath: ['outer', 'inner'],
        subCallId: 'call-x',
      }),
    )

    const state = await store.loadRun(RID)

    expect(state?.steps['outer>inner>plan']?.subPath).toEqual(['outer', 'inner'])
  })

  it('round-trips an entry with insideParallel: true', async () => {
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({
        name: 'plan',
        insideParallel: true,
      }),
    )

    const state = await store.loadRun(RID)

    expect(state?.steps.plan?.insideParallel).toBe(true)
  })

  it('omits sub-fields from the on-disk JSON when not set (no null drift)', async () => {
    const { fs, store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(RID, makeStepEntry({ name: 'root-step' }))
    const raw = await fs.readFile(path(`/runs/${RID}/state.json`))

    expect(raw).not.toContain('subPath')
    expect(raw).not.toContain('subCallId')
    expect(raw).not.toContain('insideParallel')

    const state = await store.loadRun(RID)
    expect(state?.steps['root-step']?.subPath).toBeUndefined()
    expect(state?.steps['root-step']?.subCallId).toBeUndefined()
    expect(state?.steps['root-step']?.insideParallel).toBeUndefined()
  })

  it('loads a pre-feature v5 state file (no sub-fields) cleanly', async () => {
    const { fs, store } = makeStore()
    const legacy = {
      schemaVersion: 5,
      id: RID,
      status: 'running',
      startedAt: 0,
      steps: {
        legacy: {
          name: 'legacy',
          value: 'ok',
          startedAt: 0,
          endedAt: 100,
          artifacts: [],
          validations: [],
          transcriptEventCount: 0,
          transcriptTruncated: false,
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(legacy))

    const state = await store.loadRun(RID)

    expect(state?.steps.legacy).toBeDefined()
    expect(state?.steps.legacy?.subPath).toBeUndefined()
    expect(state?.steps.legacy?.subCallId).toBeUndefined()
    expect(state?.steps.legacy?.insideParallel).toBeUndefined()
  })

  it('accepts an empty array as a legitimate subPath (root step that opted in)', async () => {
    // Defensive: deriveStepKey only sets subPath when length > 0, but the
    // schema accepts an empty array and round-trips it as such.
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(
      RID,
      makeStepEntry({
        name: 'root-explicit',
        subPath: [],
      }),
    )

    const state = await store.loadRun(RID)
    expect(state?.steps['root-explicit']?.subPath).toEqual([])
  })
})
