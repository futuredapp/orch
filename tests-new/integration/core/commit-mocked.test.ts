import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { commit } from '../../../src/core/commit.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '@orch/test/fake-host.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeDeps(overrides?: {
  processService?: FakeProcessService
  gitService?: FakeGitService
  runId?: RunId
}): WorkflowDeps & {
  processService: FakeProcessService
  gitService: FakeGitService
  clock: FakeClock
} {
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  const bunFs = new BunFsService()
  const gitService = overrides?.gitService ?? new FakeGitService()
  return {
    processService,
    clock,
    fsService: bunFs,
    gitService,
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides?.runId ?? ('r-2026-04-13-458000-q8' as RunId),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

describe('commit step integration (mocked)', () => {
  it('agent step + commit step round-trip persists correct state shape', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-commit-test-')
    const fps = new FakeProcessService()
    const git = new FakeGitService()
    git.setIsClean(path('/workspace'), false)
    git.setCommitSha(path('/workspace'), 'deadbeef1234')
    const deps = makeDeps({ processService: fps, gitService: git })

    const fr = new FakeRunner(fps)
    fr.script({ structuredOutput: 'research-done' })

    const RESEARCH = step.define('research', { agent: fr, prompt: 'do research' })

    const wf = workflow('test', async (run) => {
      await run(RESEARCH)
      await run(commit('after research'))
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(Object.keys(state?.steps ?? {})).toHaveLength(2)

    // Agent step shape
    const agentEntry = state?.steps.research
    expect(agentEntry).toBeDefined()
    expect(agentEntry?.value).toBe('research-done')

    // Commit step shape
    const commitEntry = state?.steps['commit:after-research']
    expect(commitEntry).toBeDefined()
    expect(commitEntry?.value).toEqual({ sha: 'deadbeef1234' })
    expect(commitEntry?.validations).toEqual([])
    expect(commitEntry?.preRunSnapshot).toBeUndefined()
  })

  it('commit step on clean tree persists null value', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-commit-test-')
    const git = new FakeGitService()
    git.setIsClean(path('/workspace'), true)
    const deps = makeDeps({ gitService: git })

    const wf = workflow('test', async (run) => {
      await run(commit('nothing-to-commit'))
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const commitEntry = state?.steps['commit:nothing-to-commit']
    expect(commitEntry).toBeDefined()
    expect(commitEntry?.value).toBeNull()
    expect(commitEntry?.validations).toEqual([])
  })

  it('commit step is skipped on resume when already persisted', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-commit-test-')
    const runId = 'r-2026-04-13-398232-yj' as RunId

    // First execution: commit succeeds, agent step fails
    const fps1 = new FakeProcessService()
    const git1 = new FakeGitService()
    git1.setIsClean(path('/workspace'), false)
    git1.setCommitSha(path('/workspace'), 'abc1234')
    const deps1 = makeDeps({ processService: fps1, gitService: git1, runId })

    const fr1 = new FakeRunner(fps1)
    fr1.script({ failWith: { message: 'crash' } })

    const wf1 = workflow('test', async (run) => {
      await run(commit('checkpoint'))
      await run(step.define('broken', { agent: fr1 }))
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected failure
    }

    // Verify commit was persisted
    const stateAfterFailure = await deps1.stateStore.loadRun(runId)
    expect(stateAfterFailure?.steps['commit:checkpoint']).toBeDefined()
    expect(stateAfterFailure?.status).toBe('failed')

    // Second execution: commit cached, agent step succeeds
    const fps2 = new FakeProcessService()
    const git2 = new FakeGitService()
    // No isClean/commitSha scripted — commit step should NOT call git at all
    const deps2 = makeDeps({ processService: fps2, gitService: git2, runId })

    const fr2 = new FakeRunner(fps2)
    fr2.script({ structuredOutput: 'fixed' })

    let commitResult: unknown
    const wf2 = workflow('test', async (run) => {
      commitResult = await run(commit('checkpoint'))
      await run(step.define('broken', { agent: fr2 }))
    })
    await wf2.execute(deps2)

    expect(commitResult).toEqual({ sha: 'abc1234' })

    const finalState = await deps2.stateStore.loadRun(runId)
    expect(finalState?.status).toBe('completed')
    expect(Object.keys(finalState?.steps ?? {})).toHaveLength(2)
  })
})
