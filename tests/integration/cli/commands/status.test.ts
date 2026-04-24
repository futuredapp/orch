import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { statusCmd } from '../../../../src/cli/commands/status.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { EXIT } from '../../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { makeStepEntry } from '../../../helpers/make-step-entry.ts'

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
    cwd: path('/workspace'),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
  }
}

describe('statusCmd (integration)', () => {
  it('returns EXIT.CONFIG_ERROR when no id argument is given', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const code = await statusCmd(deps, '')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns EXIT.CONFIG_ERROR when run is not found', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const code = await statusCmd(deps, 'r-2026-04-13-nope00')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns EXIT.OK and displays a completed run with steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const code = await statusCmd(deps, 'r-2026-04-13-abc001')

    expect(code).toBe(EXIT.OK)
  })

  it('resolves a partial run ID prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { startedAt: 1000 })

    const code = await statusCmd(deps, 'r-2026-04-13-abc')

    expect(code).toBe(EXIT.OK)
  })

  it('returns EXIT.CONFIG_ERROR for ambiguous prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid1 = 'r-2026-04-13-abc001' as RunId
    const rid2 = 'r-2026-04-13-abc002' as RunId
    await deps.stateStore.initRun(rid1, { startedAt: 1000 })
    await deps.stateStore.initRun(rid2, { startedAt: 2000 })

    const code = await statusCmd(deps, 'r-2026-04-13-abc')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('displays a crashed run with zero steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'fail-fast', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    const code = await statusCmd(deps, 'r-2026-04-13-abc001')

    expect(code).toBe(EXIT.OK)
  })
})
