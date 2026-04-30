import { describe, expect, it } from 'bun:test'
import {
  currentCwd,
  executionContext,
  setWorkflowCwd,
} from '../../../src/core/execution-context.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { path } from '../../../src/services/index.ts'

const FALLBACK = path('/tmp/fallback')
const A = path('/tmp/a')
const B = path('/tmp/b')

describe('currentCwd', () => {
  it('returns the fallback when no store is active', () => {
    expect(currentCwd(FALLBACK)).toBe(FALLBACK)
  })

  it('returns the fallback when workflowCwd is undefined inside an active store', async () => {
    let observed: string | undefined

    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, () => {
      observed = currentCwd(FALLBACK)
    })

    expect(observed).toBe(FALLBACK)
  })

  it('returns workflowCwd when set inside the store', async () => {
    let observed: string | undefined

    await executionContext.run({ parallelDepth: 0, workflowCwd: A }, () => {
      observed = currentCwd(FALLBACK)
    })

    expect(observed).toBe(A)
  })
})

describe('setWorkflowCwd', () => {
  it('mutates the active store and persists across awaits inside the same scope', async () => {
    let beforeAwait: string | undefined
    let afterAwait: string | undefined

    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, async () => {
      setWorkflowCwd(A)
      beforeAwait = currentCwd(FALLBACK)
      await Promise.resolve()
      afterAwait = currentCwd(FALLBACK)
    })

    expect(beforeAwait).toBe(A)
    expect(afterAwait).toBe(A)
  })

  it('throws when called outside an active executionContext scope', () => {
    expect(() => setWorkflowCwd(A)).toThrow(
      /setWorkflowCwd called outside an active executionContext scope/,
    )
  })

  it('does not leak workflowCwd from one homogeneous parallel branch to a sibling', async () => {
    const observations: { item: number; cwd: string }[] = []
    const branchSetCwds: Record<number, string> = { 1: A, 2: B }

    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, async () => {
      await parallel([1, 2], async (item) => {
        const target = branchSetCwds[item]
        if (target === undefined) throw new Error('unreachable')
        setWorkflowCwd(path(target))
        // Yield twice so the other branch has a chance to overwrite the
        // ALS store if isolation is broken.
        await Promise.resolve()
        await Promise.resolve()
        observations.push({ item, cwd: currentCwd(FALLBACK) })
      })
    })

    observations.sort((a, b) => a.item - b.item)
    expect(observations).toEqual([
      { item: 1, cwd: A },
      { item: 2, cwd: B },
    ])
  })

  it('throws when called inside a heterogeneous parallel branch (hard guard)', async () => {
    let captured: unknown
    const guarded = async (): Promise<void> => {
      await executionContext.run(
        { parallelDepth: 1, workflowCwd: undefined },
        // Heterogeneous branches share the outer store and never mark
        // homogeneousBranch — setWorkflowCwd must throw here.
        async () => {
          setWorkflowCwd(A)
        },
      )
    }

    try {
      await guarded()
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toContain('homogeneous parallel form')
  })

  it('parallel branches inherit the outer workflowCwd at branch start', async () => {
    const observed: string[] = []

    await executionContext.run({ parallelDepth: 0, workflowCwd: A }, async () => {
      await parallel([1, 2], async () => {
        observed.push(currentCwd(FALLBACK))
      })
    })

    expect(observed).toEqual([A, A])
  })
})
