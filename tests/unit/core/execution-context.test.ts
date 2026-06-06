// MIGRATED → tests-new/unit/core/execution-context.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import {
  currentCwd,
  currentSubworkflowDepth,
  currentSubworkflowPath,
  executionContext,
  isInsideParallel,
  setWorkflowCwd,
} from '../../../src/core/execution-context.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { path } from '../../../src/services/index.ts'

const FALLBACK = path('/tmp/fallback')
const A = path('/tmp/a')
const B = path('/tmp/b')

describe.skip('currentCwd', () => {
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

describe.skip('setWorkflowCwd', () => {
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

describe.skip('currentSubworkflowDepth', () => {
  it('returns 0 outside any ALS scope', () => {
    expect(currentSubworkflowDepth()).toBe(0)
  })

  it('returns 0 inside an ALS scope that does not set the field', async () => {
    let observed: number | undefined
    await executionContext.run({ parallelDepth: 0 }, () => {
      observed = currentSubworkflowDepth()
    })
    expect(observed).toBe(0)
  })

  it('returns the field when the ALS scope sets it', async () => {
    let observed: number | undefined
    await executionContext.run({ parallelDepth: 0, subworkflowDepth: 2 }, () => {
      observed = currentSubworkflowDepth()
    })
    expect(observed).toBe(2)
  })
})

describe.skip('currentSubworkflowPath', () => {
  it('returns the empty array outside any ALS scope', () => {
    expect(currentSubworkflowPath()).toEqual([])
  })

  it('returns the empty array inside an ALS scope that does not set the field', async () => {
    let observed: readonly string[] | undefined
    await executionContext.run({ parallelDepth: 0 }, () => {
      observed = currentSubworkflowPath()
    })
    expect(observed).toEqual([])
  })

  it('returns the chain when the ALS scope sets it', async () => {
    let observed: readonly string[] | undefined
    await executionContext.run({ parallelDepth: 0, subworkflowPath: ['outer', 'inner'] }, () => {
      observed = currentSubworkflowPath()
    })
    expect(observed).toEqual(['outer', 'inner'])
  })
})

describe.skip('isInsideParallel', () => {
  it('returns false outside any ALS scope', () => {
    expect(isInsideParallel()).toBe(false)
  })

  it('returns false at the workflow root (parallelDepth = 0, no insideParallel)', async () => {
    let observed: boolean | undefined
    await executionContext.run({ parallelDepth: 0 }, () => {
      observed = isInsideParallel()
    })
    expect(observed).toBe(false)
  })

  it('returns true when parallelDepth > 0 even if insideParallel is not yet set', async () => {
    // Mirrors the "parent frame inside parallel, sub not yet entered" case.
    let observed: boolean | undefined
    await executionContext.run({ parallelDepth: 1 }, () => {
      observed = isInsideParallel()
    })
    expect(observed).toBe(true)
  })

  it('returns true when insideParallel is set (descendant of sub-of-sub-inside-parallel)', async () => {
    let observed: boolean | undefined
    await executionContext.run({ parallelDepth: 0, insideParallel: true }, () => {
      observed = isInsideParallel()
    })
    expect(observed).toBe(true)
  })
})
