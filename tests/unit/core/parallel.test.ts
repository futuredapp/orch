// MIGRATED → tests-new/unit/core/parallel.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import type { AwaitedTuple, SettledEntry } from '../../../src/core/parallel.ts'
import { ParallelError, parallel } from '../../../src/core/parallel.ts'
import type { Equal, Expect } from '../../helpers/type-assertions.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rejectWith(error: unknown): Promise<never> {
  return Promise.reject(error)
}

// ---------------------------------------------------------------------------
// Heterogeneous
// ---------------------------------------------------------------------------

describe.skip('parallel (heterogeneous)', () => {
  it('two promises return values in order', async () => {
    const [a, b] = await parallel([Promise.resolve('hello'), Promise.resolve(42)])

    expect(a).toBe('hello')
    expect(b).toBe(42)
  })

  it('single-element tuple returns one value', async () => {
    const [val] = await parallel([Promise.resolve('only')])

    expect(val).toBe('only')
  })

  it('empty array returns empty array', async () => {
    const result = await parallel([])

    expect(result).toEqual([])
  })

  it('one failure produces ParallelError with settled in order', async () => {
    let caught: unknown
    try {
      await parallel([
        Promise.resolve('ok'),
        rejectWith(new Error('boom')),
        Promise.resolve('also-ok'),
      ])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ParallelError)
    const pe = caught as ParallelError
    expect(pe.settled).toHaveLength(3)
    expect(pe.settled[0]).toEqual({ status: 'ok', value: 'ok' })
    expect(pe.settled[1]?.status).toBe('error')
    expect(pe.settled[2]).toEqual({ status: 'ok', value: 'also-ok' })
  })

  it('all failures produce ParallelError', async () => {
    let caught: unknown
    try {
      await parallel([rejectWith(new Error('a')), rejectWith(new Error('b'))])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ParallelError)
    const pe = caught as ParallelError
    expect(pe.settled.every((s) => s.status === 'error')).toBe(true)
  })

  it('settled array has both ok and error entries in input order', async () => {
    let caught: unknown
    try {
      await parallel([Promise.resolve(1), rejectWith('fail'), Promise.resolve(3)])
    } catch (err) {
      caught = err
    }

    const pe = caught as ParallelError
    expect(pe.settled[0]).toEqual({ status: 'ok', value: 1 })
    expect(pe.settled[1]?.status).toBe('error')
    expect(pe.settled[2]).toEqual({ status: 'ok', value: 3 })
  })
})

// ---------------------------------------------------------------------------
// Homogeneous
// ---------------------------------------------------------------------------

describe.skip('parallel (homogeneous)', () => {
  it('maps callback and returns results in order', async () => {
    const result = await parallel([1, 2, 3], async (n) => n * 10)

    expect(result).toEqual([10, 20, 30])
  })

  it('single item returns single-element array', async () => {
    const result = await parallel(['x'], async (s) => s.toUpperCase())

    expect(result).toEqual(['X'])
  })

  it('empty array returns empty array', async () => {
    const result = await parallel([], async () => 'never')

    expect(result).toEqual([])
  })

  it('one mapped branch failure produces ParallelError', async () => {
    let caught: unknown
    try {
      await parallel([1, 2, 3], async (n) => {
        if (n === 2) throw new Error('bad')
        return n
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ParallelError)
    const pe = caught as ParallelError
    expect(pe.settled).toHaveLength(3)
    expect(pe.settled[0]).toEqual({ status: 'ok', value: 1 })
    expect(pe.settled[1]?.status).toBe('error')
    expect(pe.settled[2]).toEqual({ status: 'ok', value: 3 })
  })

  it('sync throw from callback is captured by settle-all', async () => {
    let caught: unknown
    try {
      await parallel(['a', 'b'], (item) => {
        if (item === 'a') throw new Error('sync boom')
        return Promise.resolve(item)
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ParallelError)
    const pe = caught as ParallelError
    expect(pe.settled[0]?.status).toBe('error')
    expect(pe.settled[1]).toEqual({ status: 'ok', value: 'b' })
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe.skip('parallel (concurrency)', () => {
  it('concurrency cap is never exceeded', async () => {
    let active = 0
    let maxActive = 0

    const result = await parallel(
      [1, 2, 3, 4, 5],
      async (n) => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(10)
        active--
        return n * 10
      },
      { concurrency: 2 },
    )

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(result).toEqual([10, 20, 30, 40, 50])
  })

  it('concurrency 1 runs sequentially', async () => {
    const order: number[] = []

    await parallel(
      [1, 2, 3],
      async (n) => {
        order.push(n)
        await delay(5)
        return n
      },
      { concurrency: 1 },
    )

    expect(order).toEqual([1, 2, 3])
  })

  it('concurrency greater than or equal to items runs all concurrently', async () => {
    let active = 0
    let maxActive = 0

    await parallel(
      [1, 2, 3],
      async (n) => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(10)
        active--
        return n
      },
      { concurrency: 10 },
    )

    expect(maxActive).toBe(3)
  })

  it('queued items continue after a branch fails', async () => {
    let caught: unknown
    try {
      await parallel(
        [1, 2, 3, 4],
        async (n) => {
          await delay(5)
          if (n === 1) throw new Error('fail')
          return n
        },
        { concurrency: 2 },
      )
    } catch (err) {
      caught = err
    }

    const pe = caught as ParallelError
    expect(pe.settled).toHaveLength(4)
    // Items 2, 3, 4 still ran and settled
    expect(pe.settled[1]).toEqual({ status: 'ok', value: 2 })
    expect(pe.settled[2]).toEqual({ status: 'ok', value: 3 })
    expect(pe.settled[3]).toEqual({ status: 'ok', value: 4 })
  })

  it('Infinity concurrency runs all items concurrently', async () => {
    let active = 0
    let maxActive = 0

    await parallel(
      [1, 2, 3, 4, 5],
      async (n) => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(10)
        active--
        return n
      },
      { concurrency: Number.POSITIVE_INFINITY },
    )

    expect(maxActive).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe.skip('parallel (validation)', () => {
  it('concurrency 0 throws RangeError', async () => {
    await expect(parallel([1], async (n) => n, { concurrency: 0 })).rejects.toThrow(RangeError)
  })

  it('negative concurrency throws RangeError', async () => {
    await expect(parallel([1], async (n) => n, { concurrency: -1 })).rejects.toThrow(RangeError)
  })

  it('non-integer concurrency throws RangeError', async () => {
    await expect(parallel([1], async (n) => n, { concurrency: 1.5 })).rejects.toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

describe.skip('parallel (nesting)', () => {
  it('inner ParallelError appears in outer settled array', async () => {
    let caught: unknown
    try {
      await parallel([
        Promise.resolve('outer-ok'),
        parallel([1, 2], async (n) => {
          if (n === 2) throw new Error('inner fail')
          return n
        }),
      ])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ParallelError)
    const pe = caught as ParallelError
    expect(pe.settled[0]).toEqual({ status: 'ok', value: 'outer-ok' })
    expect(pe.settled[1]?.status).toBe('error')
    const innerError = (pe.settled[1] as { status: 'error'; error: unknown }).error
    expect(innerError).toBeInstanceOf(ParallelError)
  })
})

// ---------------------------------------------------------------------------
// Compile-time type assertions
// ---------------------------------------------------------------------------

describe.skip('parallel (types)', () => {
  it('AwaitedTuple resolves [Promise<string>, Promise<number>] to [string, number]', () => {
    type _1 = Expect<Equal<AwaitedTuple<[Promise<string>, Promise<number>]>, [string, number]>>
  })

  it('AwaitedTuple resolves empty tuple to []', () => {
    type _1 = Expect<Equal<AwaitedTuple<[]>, []>>
  })

  it('homogeneous return is T[]', async () => {
    const result = await parallel([1, 2], async (n) => String(n))

    // Compile-time: result is string[]
    const _check: string[] = result
    expect(result).toEqual(['1', '2'])
  })
})

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

describe.skip('ParallelError', () => {
  it('message includes failure count', () => {
    const settled: SettledEntry[] = [
      { status: 'ok', value: 1 },
      { status: 'error', error: new Error('a') },
      { status: 'error', error: new Error('b') },
    ]
    const err = new ParallelError(settled)

    expect(err.message).toBe('2 of 3 parallel branch(es) failed')
  })

  it('settled array is accessible and readonly', () => {
    const settled: ReadonlyArray<SettledEntry> = [{ status: 'ok', value: 'x' }]
    const err = new ParallelError(settled)

    expect(err.settled).toBe(settled)
  })

  it('name is ParallelError', () => {
    const err = new ParallelError([])

    expect(err.name).toBe('ParallelError')
  })
})
