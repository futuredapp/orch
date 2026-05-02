import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../../src/cli/main.ts'
import { createPlainHost } from '../../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
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
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
  }
}

const DEFAULT_OPTS: CliOpts = {
  mode: 'plain',
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
}

const DEFAULT_HOST_FACTORY: HostFactory = async (args) =>
  createPlainHost({
    stdout: args.stdout,
    stderr: args.stderr,
    format: 'text',
    clock: args.clock,
    runId: args.runId,
  })

describe('resumeCmd state-finding (integration)', () => {
  // We import resumeCmd dynamically to avoid pulling in loadConfig's import()
  // side effects. These tests exercise the state-finding logic only —
  // they will hit the "no workflowName" or "loadConfig" error paths,
  // which is fine: we verify exit codes for those paths.

  it('returns CANNOT_RESUME when no runs exist', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const code = await resumeCmd(deps, '', {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('returns CANNOT_RESUME when all runs are completed', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'test', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'completed', 2000)

    const code = await resumeCmd(deps, '', {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('finds the latest crashed run and attempts resume', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    // Will find the crashed run, then fail on loadConfig (no orch.config.ts)
    // — which is CONFIG_ERROR, not CANNOT_RESUME
    const code = await resumeCmd(deps, '', {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns CANNOT_RESUME for explicit ID that does not match any run', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const code = await resumeCmd(
      deps,
      'r-2026-04-13-020688-q5',
      {},
      DEFAULT_OPTS,
      DEFAULT_HOST_FACTORY,
    )

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('returns CANNOT_RESUME for ambiguous prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid1 = 'r-2026-04-13-438944-09' as RunId
    const rid2 = 'r-2026-04-13-216568-id' as RunId
    await deps.stateStore.initRun(rid1, { startedAt: 1000 })
    await deps.stateStore.setStatus(rid1, 'crashed', 2000)
    await deps.stateStore.initRun(rid2, { startedAt: 3000 })
    await deps.stateStore.setStatus(rid2, 'crashed', 4000)

    const code = await resumeCmd(deps, 'r-2026-04-13-abc', {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
  })

  it('CLI prompt override is persisted before loadConfig is attempted', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-760704-6a' as RunId
    await deps.stateStore.initRun(rid, {
      workflowName: 'brainstorm',
      startedAt: 1000,
      args: { prompt: 'original' },
    })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    // loadConfig will fail (no orch.config.ts) -> CONFIG_ERROR, but setArgs
    // has already persisted by then.
    const code = await resumeCmd(
      deps,
      rid,
      { prompt: 'overridden' },
      DEFAULT_OPTS,
      DEFAULT_HOST_FACTORY,
    )
    expect(code).toBe(EXIT.CONFIG_ERROR)

    const state = await deps.stateStore.loadRun(rid)
    expect(state?.args).toEqual({ prompt: 'overridden' })
  })

  it('preserves persisted args when CLI supplies none', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    const rid = 'r-2026-04-13-538328-ne' as RunId
    await deps.stateStore.initRun(rid, {
      workflowName: 'brainstorm',
      startedAt: 1000,
      args: { prompt: 'keep me' },
    })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    await resumeCmd(deps, rid, {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    const state = await deps.stateStore.loadRun(rid)
    expect(state?.args).toEqual({ prompt: 'keep me' })
  })

  it('returns CONFIG_ERROR for pre-v5 state (prerelease — no migrations)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const deps = makeDeps()
    const { resumeCmd } = await import('../../../../src/cli/commands/resume.ts')

    // Write a raw v2 state file — v2/v3/v4 are all rejected with a wipe hint
    // after the prerelease direct-rewrite schema bump.
    const rid = 'r-2026-04-13-438944-09' as RunId
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

    const code = await resumeCmd(deps, rid, {}, DEFAULT_OPTS, DEFAULT_HOST_FACTORY)

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })
})
