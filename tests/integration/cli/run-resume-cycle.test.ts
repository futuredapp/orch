import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { runsCmd } from '../../../src/cli/commands/runs.ts'
import { statusCmd } from '../../../src/cli/commands/status.ts'
import type { CliDeps } from '../../../src/cli/deps.ts'
import { EXIT } from '../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeDeps(): CliDeps {
  const bunFs = new BunFsService()
  const basePath = path(tmpDir)
  return {
    processService: new FakeProcessService(),
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: bunFs, basePath }),
    registry: new FileRunRegistry({ fs: bunFs, basePath }),
    cwd: path(tmpDir),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
  }
}

describe('CLI run-resume cycle (integration)', () => {
  it('v3 state is written with workflowName and timestamps after initRun + setStatus', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cycle-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-657204-rg' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const raw = await fs.readFile(`${tmpDir}/${rid}/state.json`, 'utf-8')
    const state = JSON.parse(raw)

    expect(state.schemaVersion).toBe(5)
    expect(state.workflowName).toBe('deploy')
    expect(state.startedAt).toBe(1000)
    expect(state.endedAt).toBe(5000)
    expect(state.status).toBe('completed')
    expect(state.steps.plan).toBeDefined()
  })

  it('crash then resume cycle preserves v3 state fields end-to-end', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cycle-test-')
    const deps = makeDeps()

    // Simulate: init -> step A -> crash
    const rid = 'r-2026-04-13-434822-9k' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'pipeline', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'step-a', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'crashed', 2500)

    // Verify crashed state
    const crashed = await deps.stateStore.loadRun(rid)
    expect(crashed?.status).toBe('crashed')
    expect(crashed?.workflowName).toBe('pipeline')
    expect(crashed?.endedAt).toBe(2500)

    // Simulate resume: reset to running, add step B, complete
    await deps.stateStore.setStatus(rid, 'running')
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'step-b', startedAt: 3000, endedAt: 4000 }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 4500)

    const final = await deps.stateStore.loadRun(rid)
    expect(final?.status).toBe('completed')
    expect(final?.workflowName).toBe('pipeline')
    expect(final?.startedAt).toBe(1000)
    expect(final?.endedAt).toBe(4500)
    expect(Object.keys(final?.steps ?? {})).toHaveLength(2)
  })

  it('runs and status commands work on the same state files', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cycle-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-212440-qo' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'test-wf', startedAt: 1000 })
    await deps.stateStore.saveStep(rid, makeStepEntry({ name: 'build' }))
    await deps.stateStore.setStatus(rid, 'completed', 3000)

    const runsCode = await runsCmd(deps, '')
    expect(runsCode).toBe(EXIT.OK)

    const statusCode = await statusCmd(deps, rid)
    expect(statusCode).toBe(EXIT.OK)
  })
})
