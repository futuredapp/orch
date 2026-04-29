import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { BunFsService, path } from '../../../src/services/index.ts'
import { FileStateStore, type RunId, type StepEntry } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

const makeEntry = (overrides: Partial<StepEntry> = {}): StepEntry => makeStepEntry(overrides)

describe('FileStateStore (integration)', () => {
  it('round-trips against a real temp directory', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-state-test-')
    const bunFs = new BunFsService()
    const store = new FileStateStore({ fs: bunFs, basePath: path(tmpDir) })
    const id = 'r-2026-04-10-458000-q8' as RunId
    const entry = makeEntry()

    await store.saveStep(id, entry)
    const state = await store.loadRun(id)

    expect(state).toBeDefined()
    expect(state?.id).toBe(id)
    expect(state?.schemaVersion).toBe(5)
    expect(state?.steps['step-a']).toEqual(entry)
  })

  it('atomic write produces valid JSON on disk', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-state-test-')
    const bunFs = new BunFsService()
    const store = new FileStateStore({ fs: bunFs, basePath: path(tmpDir) })
    const id = 'r-2026-04-10-235624-8c' as RunId

    await store.saveStep(id, makeEntry({ name: 'disk-step', value: 'disk-val' }))

    const raw = await fs.readFile(`${tmpDir}/r-2026-04-10-235624-8c/state.json`, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.id).toBe(id)
    expect(parsed.steps['disk-step'].value).toBe('disk-val')
  })
})
