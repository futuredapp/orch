// MIGRATED → tests-new/unit/core/worktree-executor-cache.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import {
  expectedSiblingPath,
  makeCwdSpy,
  makeDeps,
  setupRepoRoot,
} from './_worktree-test-helpers.ts'

describe.skip('createWorktree() — memoization', () => {
  it('step is memoized — second invocation returns cached WorktreeResult without calling git', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
      await run(createWorktree('feat/foo', { enter: false }))
    })
    await wf.execute(deps)

    expect(deps.gitService.addWorktreeCalls.length).toBe(1)
  })

  it('cache hit with enter: true reapplies setWorkflowCwd before the next run() observes cwd', async () => {
    // First execute: write a step entry for the worktree step into state, but
    // not for the agent step. Then a second workflow invocation in the same
    // process picks up the cached worktree (cache-hit path runs onCacheHit
    // which sets cwd) and runs the agent step — which must observe the
    // worktree's path, not deps.cwd.
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    // First execute: only the worktree step runs.
    const wfWorktreeOnly = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: true }))
    })
    await wfWorktreeOnly.execute(deps)
    // Reset run status from 'completed' to 'running' so we can resume.
    await deps.stateStore.setStatus(deps.runId, 'running')

    const argv = [':cache-spy:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 0 })

    let observedCwd: string | undefined
    const SPY = step.define('inside-worktree', {
      agent: makeCwdSpy(argv, (c) => {
        observedCwd = c
      }),
    })

    // Second execute: worktree step is cache-hit, agent step runs fresh and
    // must see the worktree path because onCacheHit reapplied setWorkflowCwd.
    const wfBoth = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: true }))
      await run(SPY)
    })
    await wfBoth.resume(deps)

    expect(observedCwd).toBe(target)
    expect(deps.gitService.addWorktreeCalls.length).toBe(1)
  })

  it('createWorktree throws when two different branches slug to the same step name within one workflow', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
      await run(createWorktree('feat/Foo', { enter: false }))
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('feat/foo')
    expect((caught as Error).message).toContain('feat/Foo')
    expect(deps.gitService.addWorktreeCalls.length).toBe(1)
  })

  it('cache hit with enter: false does not mutate workflow cwd', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const argv = [':noenter-spy:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 0 })

    let observedCwd: string | undefined
    const SPY = step.define('outside-worktree', {
      agent: makeCwdSpy(argv, (c) => {
        observedCwd = c
      }),
    })

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
      await run(SPY)
    })
    await wf.execute(deps)

    expect(observedCwd).toBe(deps.cwd)
  })
})
