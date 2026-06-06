import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import {
  defineRunner,
  FakeRunner,
  type Runner,
  type RunnerContext,
} from '../../../src/runners/index.ts'
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const REPO_ROOT = path('/workspace/proj')

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
  const gitService = overrides?.gitService ?? new FakeGitService()
  const clock = new FakeClock(1000)
  const bunFs = new BunFsService()
  return {
    processService,
    gitService,
    clock,
    fsService: bunFs,
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides?.runId ?? ('r-2026-04-30-100000-w1' as RunId),
    cwd: REPO_ROOT,
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

const TERMINAL_OK = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })

/** Spy runner that captures `ctx.cwd` on each invocation. */
function makeCwdSpy(argv: readonly string[], capture: (cwd: string) => void): Runner {
  return defineRunner({
    name: 'cwd-spy',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      capture(ctx.cwd)
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  })
}

function scriptHappyWorktree(
  git: FakeGitService,
  branch: string,
  cwd = REPO_ROOT,
): { target: ReturnType<typeof path> } {
  git.setRepoRoot(cwd, cwd)
  const slug = branch.replace(/\//g, '-')
  const target = path(`/workspace/proj--${slug}`)
  git.setBranchExists(cwd, branch, false)
  git.setWorktreePathExists(cwd, target, false)
  git.allowAddWorktree(cwd)
  return { target }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorktree — mocked integration', () => {
  it('createWorktree(enter: true) followed by an agent step persists both StepEntry rows with expected shape', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-worktree-test-')
    const deps = makeDeps()
    const { target } = scriptHappyWorktree(deps.gitService, 'feat/foo')

    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'analyzed' })
    const ANALYZE = step.define('analyze', { agent: fr })

    const wf = workflow('worktree-then-agent', async (run) => {
      await run(createWorktree('feat/foo', { enter: true }))
      await run(ANALYZE)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(Object.keys(state?.steps ?? {})).toHaveLength(2)

    const wtEntry = state?.steps['worktree:feat-foo']
    expect(wtEntry).toBeDefined()
    expect(wtEntry?.value).toEqual({ path: target, branch: 'feat/foo', fromRef: 'HEAD' })
    expect(wtEntry?.validations).toEqual([])
    expect(wtEntry?.preRunSnapshot).toBeUndefined()
    expect(wtEntry?.transcriptEventCount).toBe(0)
    expect(wtEntry?.transcriptTruncated).toBe(false)

    const agentEntry = state?.steps.analyze
    expect(agentEntry).toBeDefined()
    expect(agentEntry?.value).toBe('analyzed')

    expect(deps.gitService.addWorktreeCalls).toEqual([
      { cwd: REPO_ROOT, branch: 'feat/foo', path: target, fromRef: 'HEAD' },
    ])
  })

  it('homogeneous parallel — each branch creates its own worktree without leaking cwd to siblings', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-worktree-test-')
    const deps = makeDeps()
    deps.gitService.setRepoRoot(REPO_ROOT, REPO_ROOT)
    const branches = ['feat/a', 'feat/b', 'feat/c']
    for (const branch of branches) {
      const slug = branch.replace(/\//g, '-')
      deps.gitService.setBranchExists(REPO_ROOT, branch, false)
      deps.gitService.setWorktreePathExists(REPO_ROOT, path(`/workspace/proj--${slug}`), false)
    }
    deps.gitService.allowAddWorktree(REPO_ROOT)

    const observed: Record<string, string> = {}

    const wf = workflow('worktree-homogeneous', async (run) => {
      await parallel(branches, async (branch) => {
        await run(createWorktree(branch, { enter: true }))

        const slug = branch.replace(/\//g, '-')
        const spyArgv = [':spy:', slug]
        deps.processService.when(spyArgv).respondWith({
          stdout: [TERMINAL_OK],
          exitCode: 0,
        })
        const SPY = step.define('inside', {
          agent: makeCwdSpy(spyArgv, (c) => {
            observed[branch] = c
          }),
        })
        await run(SPY, { as: `inside-${slug}` })
      })
    })
    await wf.execute(deps)

    expect(observed['feat/a']).toBe('/workspace/proj--feat-a')
    expect(observed['feat/b']).toBe('/workspace/proj--feat-b')
    expect(observed['feat/c']).toBe('/workspace/proj--feat-c')

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    // 3 worktree entries + 3 inside entries = 6
    expect(Object.keys(state?.steps ?? {})).toHaveLength(6)
    for (const branch of branches) {
      const slug = branch.replace(/\//g, '-')
      const wtEntry = state?.steps[`worktree:${slug}`]
      expect(wtEntry).toBeDefined()
      expect(wtEntry?.value).toEqual({
        path: path(`/workspace/proj--${slug}`),
        branch,
        fromRef: 'HEAD',
      })
      expect(state?.steps[`inside-${slug}`]).toBeDefined()
    }

    // Each branch produced exactly one addWorktree call.
    expect(deps.gitService.addWorktreeCalls.length).toBe(3)
    const calledBranches = deps.gitService.addWorktreeCalls.map((c) => c.branch).sort()
    expect(calledBranches).toEqual(['feat/a', 'feat/b', 'feat/c'])
  })

  it('parallel branches that crashed mid-execution resume on a fresh process: each branch hits its cache and reapplies cwd in its own ALS scope', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-worktree-test-')
    const sharedRunId = 'r-2026-04-30-100100-w2' as RunId

    // -------------------------------- First run --------------------------------
    const fps1 = new FakeProcessService()
    const git1 = new FakeGitService()
    git1.setRepoRoot(REPO_ROOT, REPO_ROOT)
    for (const item of ['a', 'b']) {
      git1.setBranchExists(REPO_ROOT, `feat/${item}`, false)
      git1.setWorktreePathExists(REPO_ROOT, path(`/workspace/proj--feat-${item}`), false)
    }
    git1.allowAddWorktree(REPO_ROOT)
    const deps1 = makeDeps({ processService: fps1, gitService: git1, runId: sharedRunId })

    // Branch a's work succeeds, branch b's work crashes
    const frA = new FakeRunner(fps1)
    frA.script({ structuredOutput: 'done-a' })
    const frB = new FakeRunner(fps1)
    frB.script({ failWith: { message: 'boom-b' } })

    const wf1 = workflow('parallel-resume', async (run) => {
      await parallel(
        [
          { item: 'a', runner: frA },
          { item: 'b', runner: frB },
        ],
        async ({ item, runner }) => {
          await run(createWorktree(`feat/${item}`, { enter: true }))
          await run(step.define('work', { agent: runner }), { as: `work-${item}` })
        },
      )
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected — branch b failed
    }

    const failed = await deps1.stateStore.loadRun(sharedRunId)
    expect(failed?.status).toBe('failed')
    expect(failed?.steps['worktree:feat-a']).toBeDefined()
    expect(failed?.steps['worktree:feat-b']).toBeDefined()
    expect(failed?.steps['work-a']?.value).toBe('done-a')
    expect(failed?.steps['work-b']).toBeUndefined()
    expect(git1.addWorktreeCalls.length).toBe(2)

    // -------------------------------- Resume run -------------------------------
    // Both worktrees are cache-hit. Branch a's work is also cache-hit. Branch
    // b's work re-runs and must observe the worktree path as cwd — verifying
    // onCacheHit re-applied setWorkflowCwd inside branch b's ALS scope.
    const fps2 = new FakeProcessService()
    const git2 = new FakeGitService()
    // Intentionally not scripting any git ops on git2 — cache hits must not
    // call git.
    const deps2 = makeDeps({ processService: fps2, gitService: git2, runId: sharedRunId })

    const observedCwd: Record<string, string> = {}

    const wf2 = workflow('parallel-resume', async (run) => {
      await parallel(['a', 'b'], async (item) => {
        await run(createWorktree(`feat/${item}`, { enter: true }))
        const spyArgv = [':resume-spy:', item]
        fps2.when(spyArgv).respondWith({
          stdout: [JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })],
          exitCode: 0,
        })
        const SPY = step.define('work', {
          agent: makeCwdSpy(spyArgv, (c) => {
            observedCwd[item] = c
          }),
        })
        await run(SPY, { as: `work-${item}` })
      })
    })
    await wf2.resume(deps2)

    // Branch a was fully cached — spy never ran.
    expect(observedCwd.a).toBeUndefined()
    // Branch b's worktree was cache-hit and re-applied cwd; spy saw the worktree path.
    expect(observedCwd.b).toBe('/workspace/proj--feat-b')

    // No git calls in the resume — both worktrees were cache-hit.
    expect(git2.addWorktreeCalls.length).toBe(0)

    const final = await deps2.stateStore.loadRun(sharedRunId)
    expect(final?.status).toBe('completed')
    expect(Object.keys(final?.steps ?? {})).toHaveLength(4)
  })

  it('resume crashed inside postCreate re-runs the entire step (strict — no partial cache)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-worktree-test-')
    const sharedRunId = 'r-2026-04-30-100200-w3' as RunId

    // -------------------------------- First run --------------------------------
    const fps1 = new FakeProcessService()
    const git1 = new FakeGitService()
    scriptHappyWorktree(git1, 'feat/foo')
    fps1.when(['/bin/sh', '-c', 'cmd1']).respondWith({
      stdout: [],
      stderr: ['boom'],
      exitCode: 1,
    })

    const deps1 = makeDeps({ processService: fps1, gitService: git1, runId: sharedRunId })

    const wf1 = workflow('postcreate-fail', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, postCreate: ['cmd1', 'cmd2'] }))
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected — postCreate exits 1
    }

    const afterCrash = await deps1.stateStore.loadRun(sharedRunId)
    expect(afterCrash?.status).toBe('crashed')
    // Strict: step is NOT memoized when postCreate fails (worktree on disk is
    // left for the user to inspect; cache only records full-success).
    expect(afterCrash?.steps['worktree:feat-foo']).toBeUndefined()
    expect(git1.addWorktreeCalls.length).toBe(1)

    // -------------------------------- Resume run -------------------------------
    // Fresh git service simulates the user having run
    // `git worktree remove --force` before resuming. Both git ops succeed and
    // both postCreate lines run cleanly — verifying the entire step body
    // re-executes (no partial cache).
    const fps2 = new FakeProcessService()
    const git2 = new FakeGitService()
    const { target: target2 } = scriptHappyWorktree(git2, 'feat/foo')
    fps2.when(['/bin/sh', '-c', 'cmd1']).respondWith({ stdout: [], exitCode: 0 })
    fps2.when(['/bin/sh', '-c', 'cmd2']).respondWith({ stdout: [], exitCode: 0 })

    const deps2 = makeDeps({ processService: fps2, gitService: git2, runId: sharedRunId })

    const wf2 = workflow('postcreate-fail', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, postCreate: ['cmd1', 'cmd2'] }))
    })
    await wf2.resume(deps2)

    const final = await deps2.stateStore.loadRun(sharedRunId)
    expect(final?.status).toBe('completed')
    const wtEntry = final?.steps['worktree:feat-foo']
    expect(wtEntry).toBeDefined()
    expect(wtEntry?.value).toEqual({ path: target2, branch: 'feat/foo', fromRef: 'HEAD' })

    // The step ran fresh on resume — git was called once on the new fake.
    expect(git2.addWorktreeCalls.length).toBe(1)
  })
})
