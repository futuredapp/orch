// U3 — parallel() branchStore propagation. Asserts that a hypothetical
// `runWorkflow` invocation inside a parallel branch would see the parent's
// `subworkflowPath`, `subCallId`, `runFnRef`, `loggerRef`, and
// `maxSubworkflowDepth`.
//
// Without this propagation, sibling parallel branches would (a) read
// `runFnRef === undefined` and trip U5's outside-scope guard, (b) read
// `subworkflowPath === []` and key sub-internal steps under the wrong cache
// key (sibling branches' steps with shared names would collide), and
// (c) lose the per-execution depth bound set by `WorkflowDeps`.

import { describe, expect, it } from 'bun:test'
import { executionContext } from '../../../src/core/execution-context.ts'
import { parallel } from '../../../src/core/parallel.ts'
import type { RunFn } from '../../../src/core/workflow.ts'

const dummyRunFn = (() => {
  throw new Error('test placeholder — runFnRef should not be invoked here')
}) as unknown as RunFn

describe('parallel() branchStore — subworkflow field propagation', () => {
  it('propagates runFnRef into every branch so runWorkflow inside the branch can read it', async () => {
    const observed: Array<RunFn | undefined> = []

    await executionContext.run(
      {
        parallelDepth: 0,
        runFnRef: dummyRunFn,
      },
      async () => {
        await parallel([1, 2], async () => {
          observed.push(executionContext.getStore()?.runFnRef)
        })
      },
    )

    expect(observed).toHaveLength(2)
    expect(observed[0]).toBe(dummyRunFn)
    expect(observed[1]).toBe(dummyRunFn)
  })

  it('propagates subworkflowPath so sibling branches share the same prefix at branch entry', async () => {
    const observed: Array<readonly string[] | undefined> = []

    await executionContext.run(
      {
        parallelDepth: 0,
        subworkflowPath: ['outer'],
      },
      async () => {
        await parallel([1, 2], async () => {
          observed.push(executionContext.getStore()?.subworkflowPath)
        })
      },
    )

    expect(observed[0]).toEqual(['outer'])
    expect(observed[1]).toEqual(['outer'])
  })

  it('propagates subCallId so branch-local steps belong to the enclosing sub invocation', async () => {
    const observed: Array<string | undefined> = []

    await executionContext.run(
      {
        parallelDepth: 0,
        subworkflowPath: ['outer'],
        subworkflowDepth: 1,
        subCallId: 'call-outer',
      },
      async () => {
        await parallel([1, 2], async () => {
          observed.push(executionContext.getStore()?.subCallId)
        })
      },
    )

    expect(observed[0]).toBe('call-outer')
    expect(observed[1]).toBe('call-outer')
  })

  it('propagates subworkflowDepth so nested runWorkflow inside a branch starts from the parent depth', async () => {
    const observed: Array<number | undefined> = []

    await executionContext.run(
      {
        parallelDepth: 0,
        subworkflowDepth: 3,
      },
      async () => {
        await parallel([1, 2], async () => {
          observed.push(executionContext.getStore()?.subworkflowDepth)
        })
      },
    )

    expect(observed[0]).toBe(3)
    expect(observed[1]).toBe(3)
  })

  it('always marks insideParallel: true on the branch store', async () => {
    const observed: Array<true | undefined> = []

    await executionContext.run({ parallelDepth: 0 }, async () => {
      await parallel([1, 2], async () => {
        observed.push(executionContext.getStore()?.insideParallel)
      })
    })

    expect(observed[0]).toBe(true)
    expect(observed[1]).toBe(true)
  })

  it('propagates maxSubworkflowDepth so the depth guard reads the parent snapshot', async () => {
    const observed: Array<number | undefined> = []

    await executionContext.run(
      {
        parallelDepth: 0,
        maxSubworkflowDepth: 4,
      },
      async () => {
        await parallel([1, 2], async () => {
          observed.push(executionContext.getStore()?.maxSubworkflowDepth)
        })
      },
    )

    expect(observed[0]).toBe(4)
    expect(observed[1]).toBe(4)
  })

  it('does not leak a sub-frame mutation across sibling branches', async () => {
    // Two branches concurrently mutate their own ALS frame. If branch isolation
    // were broken, one would observe the other's value.
    const observations: { item: number; path: readonly string[] | undefined }[] = []

    await executionContext.run(
      {
        parallelDepth: 0,
        subworkflowPath: ['root'],
      },
      async () => {
        await parallel([1, 2], async (item) => {
          // Push our own branch-local frame on top.
          await executionContext.run(
            {
              ...executionContext.getStore(),
              parallelDepth: 1,
              subworkflowPath: [
                ...(executionContext.getStore()?.subworkflowPath ?? []),
                `b${item}`,
              ],
            },
            async () => {
              await Promise.resolve()
              await Promise.resolve()
              observations.push({
                item,
                path: executionContext.getStore()?.subworkflowPath,
              })
            },
          )
        })
      },
    )

    observations.sort((a, b) => a.item - b.item)
    expect(observations).toEqual([
      { item: 1, path: ['root', 'b1'] },
      { item: 2, path: ['root', 'b2'] },
    ])
  })
})
