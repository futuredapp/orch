// MIGRATED → tests-new/unit/services/clock/fake-clock.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'

describe.skip('FakeClock', () => {
  it('reports the initial value from now() when constructed with an explicit seed', () => {
    const clock = new FakeClock(1000)

    expect(clock.now()).toBe(1000)
  })

  it('defaults the initial value to zero when constructed with no argument', () => {
    const clock = new FakeClock()

    expect(clock.now()).toBe(0)
  })

  it('moves forward monotonically after advance(ms)', () => {
    const clock = new FakeClock(100)

    clock.advance(50)
    expect(clock.now()).toBe(150)

    clock.advance(25)
    expect(clock.now()).toBe(175)
  })

  it('allows set(ms) to move the clock backward for state replay tests', () => {
    const clock = new FakeClock(1000)

    clock.set(500)
    expect(clock.now()).toBe(500)

    clock.set(2000)
    expect(clock.now()).toBe(2000)
  })
})
