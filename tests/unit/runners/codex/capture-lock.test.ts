import { describe, expect, it } from 'bun:test'
import { createCaptureLock } from '../../../../src/runners/codex/capture-lock.ts'

describe('createCaptureLock', () => {
  it('returns independent lock instances that do not block each other', async () => {
    const lockA = createCaptureLock()
    const lockB = createCaptureLock()

    const releaseA = await lockA.acquire()
    const releaseB = await lockB.acquire()

    expect(releaseA).toBeInstanceOf(Function)
    expect(releaseB).toBeInstanceOf(Function)

    releaseA()
    releaseB()
  })

  it('serializes two acquires on the same lock in FIFO order', async () => {
    const lock = createCaptureLock()
    const order: string[] = []

    const releaseFirst = await lock.acquire()
    order.push('first-acquired')

    const secondAcquire = lock.acquire().then((release) => {
      order.push('second-acquired')
      return release
    })

    // Yield so the second acquire's microtasks run if it were going to resolve early.
    await Promise.resolve()
    expect(order).toEqual(['first-acquired'])

    releaseFirst()
    const releaseSecond = await secondAcquire
    expect(order).toEqual(['first-acquired', 'second-acquired'])

    releaseSecond()
  })

  it('serializes three concurrent acquires strictly in FIFO order on a single lock', async () => {
    const lock = createCaptureLock()
    const order: number[] = []

    const a = lock.acquire().then((release) => {
      order.push(1)
      return release
    })
    const b = lock.acquire().then((release) => {
      order.push(2)
      return release
    })
    const c = lock.acquire().then((release) => {
      order.push(3)
      return release
    })

    const releaseA = await a
    expect(order).toEqual([1])
    releaseA()

    const releaseB = await b
    expect(order).toEqual([1, 2])
    releaseB()

    const releaseC = await c
    expect(order).toEqual([1, 2, 3])
    releaseC()
  })

  it('ignores a second release call so subsequent acquires still work', async () => {
    const lock = createCaptureLock()

    const release1 = await lock.acquire()
    release1()
    release1() // Double-release must not corrupt internal state.

    const release2 = await lock.acquire()
    expect(release2).toBeInstanceOf(Function)
    release2()

    const release3 = await lock.acquire()
    expect(release3).toBeInstanceOf(Function)
    release3()
  })

  it('does not let an unreleased acquire on one lock poison another lock', async () => {
    const poisoned = createCaptureLock()
    const fresh = createCaptureLock()

    // Acquire and never release on `poisoned`.
    await poisoned.acquire()

    // The fresh lock must still be acquirable immediately.
    const release = await fresh.acquire()
    expect(release).toBeInstanceOf(Function)
    release()
  })
})
