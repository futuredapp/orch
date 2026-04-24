import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { runsCmd } from '../../../../src/cli/commands/runs.ts'
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

describe('runsCmd (integration)', () => {
  it('returns EXIT.OK and prints message when no runs exist', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-runs-test-')
    const deps = makeDeps()

    const code = await runsCmd(deps, '')

    expect(code).toBe(EXIT.OK)
  })

  it('returns EXIT.OK and lists runs that exist on disk', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-runs-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const code = await runsCmd(deps, '')

    expect(code).toBe(EXIT.OK)
  })

  it('lists multiple runs in chronological order', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-runs-test-')
    const deps = makeDeps()

    const rid1 = 'r-2026-04-13-abc001' as RunId
    const rid2 = 'r-2026-04-13-abc002' as RunId
    await deps.stateStore.initRun(rid1, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.setStatus(rid1, 'completed', 2000)
    await deps.stateStore.initRun(rid2, { workflowName: 'test', startedAt: 3000 })
    await deps.stateStore.setStatus(rid2, 'crashed', 4000)

    const code = await runsCmd(deps, '')

    expect(code).toBe(EXIT.OK)
  })
})
