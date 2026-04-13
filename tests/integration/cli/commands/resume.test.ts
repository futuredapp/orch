import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { EXIT } from '../../../../src/cli/main.ts'
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
    cwd: path(tmpDir),
  }
}

describe('resumeCmd state-finding (integration)', () => {
  // We import resumeCmd dynamically to avoid pulling in loadConfig's import()
  // side effects. These tests exercise the state-finding logic only —
  // they will hit the "no workflowName" or "loadConfig" error paths,
  // which is fine: we verify exit codes for those paths.

  it('returns CANNOT_RESUME when no runs exist', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const code = await resumeCmd(deps, '')

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('returns CANNOT_RESUME when all runs are completed', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'test', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'completed', 2000)

    const code = await resumeCmd(deps, '')

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('finds the latest crashed run and attempts resume', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-abc001' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    // Will find the crashed run, then fail on loadConfig (no orch.config.ts)
    // — which is CONFIG_ERROR, not CANNOT_RESUME
    const code = await resumeCmd(deps, '')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns CANNOT_RESUME for explicit ID that does not match any run', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const code = await resumeCmd(deps, 'r-2026-04-13-nope00')

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('returns CANNOT_RESUME for ambiguous prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid1 = 'r-2026-04-13-abc001' as RunId
    const rid2 = 'r-2026-04-13-abc002' as RunId
    await deps.stateStore.initRun(rid1, { startedAt: 1000 })
    await deps.stateStore.setStatus(rid1, 'crashed', 2000)
    await deps.stateStore.initRun(rid2, { startedAt: 3000 })
    await deps.stateStore.setStatus(rid2, 'crashed', 4000)

    const code = await resumeCmd(deps, 'r-2026-04-13-abc')

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('returns CANNOT_RESUME for v2 state without workflowName', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    // Write a raw v2 state file (no workflowName)
    const rid = 'r-2026-04-13-abc001' as RunId
    const ridDir = `${tmpDir}/${rid}`
    await fs.mkdir(ridDir, { recursive: true })
    await fs.writeFile(
      `${ridDir}/state.json`,
      JSON.stringify({
        schemaVersion: 2,
        id: rid,
        status: 'crashed',
        steps: {},
      }),
    )

    const code = await resumeCmd(deps, rid)

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })
})
