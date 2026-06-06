// MIGRATED → tests-new/unit/core/worktree-executor.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import { path } from '../../../src/core/types.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  expectedSiblingPath,
  makeCwdSpy,
  makeDeps,
  setupRepoRoot,
} from './_worktree-test-helpers.ts'

describe.skip('createWorktree() — happy paths', () => {
  it('creates a worktree at the sibling default and persists WorktreeResult to state.json', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    let observed: unknown
    const wf = workflow('test', async (run) => {
      observed = await run(createWorktree('feat/foo', { enter: false }))
    })
    await wf.execute(deps)

    expect(observed).toEqual({ path: target, branch: 'feat/foo', fromRef: 'HEAD' })

    const state = await deps.stateStore.loadRun(deps.runId)
    const entry = state?.steps['worktree:feat-foo']
    expect(entry).toBeDefined()
    expect(entry?.value).toEqual({ path: target, branch: 'feat/foo', fromRef: 'HEAD' })
    expect(entry?.validations).toEqual([])
    expect(entry?.transcriptEventCount).toBe(0)

    expect(deps.gitService.addWorktreeCalls).toEqual([
      { cwd: deps.cwd, branch: 'feat/foo', path: target, fromRef: 'HEAD' },
    ])
  })

  it('enter: true mutates the workflow cwd for subsequent run() calls', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const argv = [':cwd-spy:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 0 })

    let observedCwd: string | undefined
    const spy = makeCwdSpy(argv, (c) => {
      observedCwd = c
    })
    const SPY = step.define('after-worktree', { agent: spy })

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: true }))
      await run(SPY)
    })
    await wf.execute(deps)

    expect(observedCwd).toBe(target)
  })

  it('enter: false leaves the workflow cwd unchanged', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const argv = [':cwd-spy:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 0 })

    let observedCwd: string | undefined
    const spy = makeCwdSpy(argv, (c) => {
      observedCwd = c
    })
    const SPY = step.define('after-worktree', { agent: spy })

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
      await run(SPY)
    })
    await wf.execute(deps)

    expect(observedCwd).toBe(deps.cwd)
  })

  it('from override drives git addWorktree fromRef argument', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, from: 'main' }))
    })
    await wf.execute(deps)

    expect(deps.gitService.addWorktreeCalls[0]?.fromRef).toBe('main')
  })

  it('target as an absolute path resolves the leaf inside that directory', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = path('/tmp/wts/proj--feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, target: '/tmp/wts' }))
    })
    await wf.execute(deps)

    expect(deps.gitService.addWorktreeCalls[0]?.path).toBe(target)
  })

  it('target as a relative path resolves the leaf relative to repoRoot', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = path('/workspace/wts/proj--feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, target: '../wts' }))
    })
    await wf.execute(deps)

    expect(deps.gitService.addWorktreeCalls[0]?.path).toBe(target)
  })

  it('inside an active worktree (nested), createWorktree resolves repoRoot from currentCwd, not deps.cwd', async () => {
    const deps = makeDeps()
    const outerCwd = deps.cwd
    const innerCwd = path('/workspace/proj--feat-foo')
    setupRepoRoot(deps.gitService, outerCwd)
    deps.gitService.setRepoRoot(innerCwd, innerCwd)
    deps.gitService.setBranchExists(outerCwd, 'feat/foo', false)
    deps.gitService.setBranchExists(innerCwd, 'feat/bar', false)
    const targetOuter = expectedSiblingPath('feat-foo')
    const targetInner = path('/workspace/proj--feat-foo--feat-bar')
    deps.gitService.setWorktreePathExists(outerCwd, targetOuter, false)
    deps.gitService.setWorktreePathExists(innerCwd, targetInner, false)
    deps.gitService.allowAddWorktree(outerCwd)
    deps.gitService.allowAddWorktree(innerCwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: true }))
      await run(createWorktree('feat/bar', { enter: false }))
    })
    await wf.execute(deps)

    expect(deps.gitService.addWorktreeCalls.length).toBe(2)
    expect(deps.gitService.addWorktreeCalls[1]?.cwd).toBe(innerCwd)
    expect(deps.gitService.addWorktreeCalls[1]?.path).toBe(targetInner)
  })

  it('does not invoke any Runner during createWorktree (negative boundary)', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const fr = new FakeRunner(deps.processService)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
    })
    await wf.execute(deps)

    expect(fr.invocationCount).toBe(0)
  })
})
