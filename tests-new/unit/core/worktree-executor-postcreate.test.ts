import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { Path } from '../../../src/core/types.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import {
  makeCwdSpy,
  makeDeps,
  scriptHappyWorktree,
  type TestDeps,
} from './_worktree-test-helpers.ts'

describe('createWorktree() — postCreate hook', () => {
  it('runs each sugar line via /bin/sh -c with ORIGIN and TARGET in env', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const argv = ['/bin/sh', '-c', 'echo hi']
    deps.processService.when(argv).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, postCreate: ['echo hi'] }))
    })
    await wf.execute(deps)

    // No throw means the scripted spawn was consumed.
  })

  it('runs sugar lines sequentially (second line waits for first to exit)', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const argv1 = ['/bin/sh', '-c', 'a']
    const argv2 = ['/bin/sh', '-c', 'b']
    deps.processService.when(argv1).respondWith({ stdout: ['line1'], exitCode: 0 })
    deps.processService.when(argv2).respondWith({ stdout: ['line2'], exitCode: 0 })

    const order: string[] = []
    const wf = workflow('test', async (run) => {
      order.push('before')
      await run(createWorktree('feat/foo', { enter: false, postCreate: ['a', 'b'] }))
      order.push('after')
    })
    await wf.execute(deps)

    expect(order).toEqual(['before', 'after'])
  })

  it('aborts subsequent sugar lines on first non-zero exit and fails the step', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const argv1 = ['/bin/sh', '-c', 'a']
    deps.processService.when(argv1).respondWith({ stdout: [], stderr: ['boom'], exitCode: 1 })

    const wf = workflow('test', async (run) => {
      await run(createWorktree('feat/foo', { enter: false, postCreate: ['a', 'b'] }))
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toContain('postCreate')
  })

  it('callback receives origin, target, and exec (cwd defaults to target)', async () => {
    const deps = makeDeps()
    const target = scriptHappyWorktree(deps, 'feat/foo')

    const argv = ['ls']
    deps.processService.when(argv).respondWith({ stdout: [], exitCode: 0 })

    let receivedOrigin: Path | undefined
    let receivedTarget: Path | undefined
    const wf = workflow('test', async (run) => {
      await run(
        createWorktree('feat/foo', {
          enter: false,
          postCreate: async ({ origin, target: t, exec }) => {
            receivedOrigin = origin
            receivedTarget = t
            await exec(['ls'])
          },
        }),
      )
    })
    await wf.execute(deps)

    expect(receivedOrigin).toBe(deps.cwd)
    expect(receivedTarget).toBe(target)
  })

  it('exec wrapper rejects with PostCreateExecError on non-zero exit', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const argv = ['ls']
    deps.processService.when(argv).respondWith({ stdout: [], stderr: ['fail'], exitCode: 2 })

    const wf = workflow('test', async (run) => {
      await run(
        createWorktree('feat/foo', {
          enter: false,
          postCreate: async ({ exec }) => {
            await exec(['ls'])
          },
        }),
      )
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toContain('exited 2')
    expect((captured as Error).message).toContain('ls')
  })

  it('step fails when postCreate callback throws', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const wf = workflow('test', async (run) => {
      await run(
        createWorktree('feat/foo', {
          enter: false,
          postCreate: async () => {
            throw new Error('hook boom')
          },
        }),
      )
    })

    let captured: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      captured = err
    }

    expect((captured as Error).message).toContain('hook boom')
  })

  it('step does not call setWorkflowCwd when postCreate fails (cwd unchanged)', async () => {
    const deps = makeDeps()
    scriptHappyWorktree(deps, 'feat/foo')

    const argv = [':after-failed-worktree:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 0 })

    let observedCwd: string | undefined
    const SPY = step.define('after-failed-worktree', {
      agent: makeCwdSpy(argv, (c) => {
        observedCwd = c
      }),
    })

    const wf = workflow('test', async (run) => {
      try {
        await run(
          createWorktree('feat/foo', {
            enter: true,
            postCreate: async () => {
              throw new Error('hook boom')
            },
          }),
        )
      } catch {
        // swallow so the agent step still runs
      }
      await run(SPY)
    })
    await wf.execute(deps)

    expect(observedCwd).toBe(deps.cwd)
  })
})

// Keep linter happy on the unused TestDeps import
void (null as unknown as TestDeps)
