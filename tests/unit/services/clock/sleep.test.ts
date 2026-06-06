// MIGRATED → tests-new/unit/services/clock/sleep.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { BunClock } from '../../../../src/services/clock/bun-clock.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'

describe.skip('Clock.sleep', () => {
  describe('BunClock', () => {
    it('resolves only after the requested duration has elapsed in real time', async () => {
      const clock = new BunClock()

      const before = Date.now()
      await clock.sleep(50)
      const elapsed = Date.now() - before

      expect(elapsed).toBeGreaterThanOrEqual(45)
    })

    it('resolves immediately when given zero milliseconds', async () => {
      const clock = new BunClock()

      const before = Date.now()
      await clock.sleep(0)
      const elapsed = Date.now() - before

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('FakeClock', () => {
    it('leaves a sleep(50) promise unresolved until advance(50) has fired', async () => {
      const clock = new FakeClock(0)
      let resolved = false

      const sleeping = clock.sleep(50).then(() => {
        resolved = true
      })

      // Yield once so the .then handler runs if the promise resolved early.
      await Promise.resolve()
      expect(resolved).toBe(false)

      clock.advance(49)
      await Promise.resolve()
      expect(resolved).toBe(false)

      clock.advance(1)
      await sleeping
      expect(resolved).toBe(true)
    })

    it('resolves multiple pending sleepers in dueAt order when advance crosses several deadlines', async () => {
      const clock = new FakeClock(0)
      const order: string[] = []

      const a = clock.sleep(30).then(() => order.push('a'))
      const b = clock.sleep(10).then(() => order.push('b'))
      const c = clock.sleep(20).then(() => order.push('c'))

      clock.advance(100)
      await Promise.all([a, b, c])

      expect(order).toEqual(['b', 'c', 'a'])
    })

    it('resolves a sleeper exactly once when advance crosses past its deadline', async () => {
      const clock = new FakeClock(0)
      let resolutionCount = 0

      const sleeping = clock.sleep(5).then(() => {
        resolutionCount += 1
      })

      clock.advance(100)
      await sleeping

      clock.advance(100)
      await Promise.resolve()

      expect(resolutionCount).toBe(1)
    })

    it('resolves a sleep(0) call on the next advance(0) tick', async () => {
      const clock = new FakeClock(0)
      let resolved = false

      const sleeping = clock.sleep(0).then(() => {
        resolved = true
      })

      await Promise.resolve()
      expect(resolved).toBe(false)

      clock.advance(0)
      await sleeping

      expect(resolved).toBe(true)
    })
  })
})
