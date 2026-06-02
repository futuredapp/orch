// U8 — `StepEntry.recoveryLog` persistence (R16). Additive, optional, no
// schemaVersion bump; pre-feature state files load with it undefined. The
// `outcome` field is forward-tolerant (`z.string()`, not a `z.enum`) so a value
// written by a future phase cannot reject a whole Phase-1 state-file load.

import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import {
  FileStateStore,
  type PersistedRecoveryLogEntry,
  type RunId,
} from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const BASE = path('/runs')
const RID = 'r-2026-06-02-200001-a1' as RunId

function makeStore() {
  const fs = new FakeFsService()
  return { fs, store: new FileStateStore({ fs, basePath: BASE }) }
}

const LOG: readonly PersistedRecoveryLogEntry[] = [
  {
    attemptIndex: 1,
    errorClass: 'overload',
    waitMs: 300_000,
    parentSessionId: 'checkpoint-0',
    forkSessionId: 'fork-1',
    outcome: 'progressed',
  },
  {
    attemptIndex: 2,
    errorClass: 'overload',
    waitMs: 300_000,
    parentSessionId: 'checkpoint-0',
    forkSessionId: 'fork-2',
    outcome: 'completed',
  },
]

describe('StepEntry.recoveryLog persistence', () => {
  it('round-trips a recovery log with one entry per attempt', async () => {
    const { store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(RID, makeStepEntry({ name: 'analyze', recoveryLog: LOG }))

    const state = await store.loadRun(RID)

    expect(state?.steps.analyze?.recoveryLog).toEqual(LOG)
  })

  it('omits recoveryLog from on-disk JSON when absent (no null drift)', async () => {
    const { fs, store } = makeStore()
    await store.initRun(RID, { startedAt: 0 })
    await store.saveStep(RID, makeStepEntry({ name: 'plain' }))

    const raw = await fs.readFile(path(`/runs/${RID}/state.json`))
    expect(raw).not.toContain('recoveryLog')

    const state = await store.loadRun(RID)
    expect(state?.steps.plain?.recoveryLog).toBeUndefined()
  })

  it('loads a pre-feature v5 state file (no recoveryLog) cleanly', async () => {
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

    expect(state?.steps.legacy?.recoveryLog).toBeUndefined()
  })

  it('loads a state file with an unknown future outcome without rejecting the whole file', async () => {
    // Phase 2 shares this field; a Phase-2-written outcome value must not break
    // a Phase-1 load. The `z.string()` boundary accepts it verbatim.
    const { fs, store } = makeStore()
    const futureFile = {
      schemaVersion: 5,
      id: RID,
      status: 'failed',
      startedAt: 0,
      steps: {
        analyze: {
          name: 'analyze',
          value: null,
          startedAt: 0,
          endedAt: 100,
          artifacts: [],
          validations: [],
          transcriptEventCount: 0,
          transcriptTruncated: false,
          recoveryLog: [
            {
              attemptIndex: 1,
              errorClass: 'some-future-class',
              waitMs: 1000,
              parentSessionId: 'p',
              outcome: 'remediated-via-screenshot',
            },
          ],
        },
      },
    }
    await fs.mkdir(path(`/runs/${RID}`), { recursive: true })
    await fs.writeFile(path(`/runs/${RID}/state.json`), JSON.stringify(futureFile))

    const state = await store.loadRun(RID)

    expect(state?.steps.analyze?.recoveryLog?.[0]?.outcome).toBe('remediated-via-screenshot')
    expect(state?.steps.analyze?.recoveryLog?.[0]?.forkSessionId).toBeUndefined()
  })
})
