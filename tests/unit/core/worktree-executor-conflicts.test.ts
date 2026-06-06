// MIGRATED → tests-new/unit/core/worktree-executor-conflicts.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import { GitCommandError } from '../../../src/services/index.ts'
import { expectedSiblingPath, makeDeps, setupRepoRoot } from './_worktree-test-helpers.ts'

describe.skip('createWorktree() — conflicts', () => {
  it('throws GitCommandError when branchExists returns true', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', true)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(GitCommandError)
    expect((captured as GitCommandError).message).toContain('branch "feat/foo" already exists')
  })

  it('throws GitCommandError when worktreePathExists returns true', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setWorktreePathExists(deps.cwd, target, true)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(GitCommandError)
    expect((captured as GitCommandError).message).toContain('already registered')
  })

  it('does not call git addWorktree when a conflict is detected (negative boundary)', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', true)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }))
    })

    try {
      await wf.execute(deps)
    } catch {
      // expected
    }

    expect(deps.gitService.addWorktreeCalls.length).toBe(0)
  })
})

describe.skip('createWorktree() — override rejection', () => {
  it('throws when prompt override is provided', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)
    deps.gitService.allowAddWorktree(deps.cwd)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }), { prompt: 'nope' })
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect((captured as Error).message).toContain('does not accept prompt')
  })

  it('throws when extraContext override is provided', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }), { extraContext: { x: 1 } })
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect((captured as Error).message).toContain('extraContext')
  })

  it('throws when extraPrompt override is provided', async () => {
    const deps = makeDeps()
    setupRepoRoot(deps.gitService)
    const target = expectedSiblingPath('feat-foo')
    deps.gitService.setBranchExists(deps.cwd, 'feat/foo', false)
    deps.gitService.setWorktreePathExists(deps.cwd, target, false)

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false }), { extraPrompt: 'nope' })
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect((captured as Error).message).toContain('extraPrompt')
  })
})
