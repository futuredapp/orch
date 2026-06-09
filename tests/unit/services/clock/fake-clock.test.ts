import { describe, expect, it } from 'bun:test'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'

describe('FakeClock', () => {
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

  it('resolves a sleep early when its abort signal fires and drops the sleeper (U7 watchdog)', async () => {
    const clock = new FakeClock(0)
    const controller = new AbortController()

    let resolved = false
    const pending = clock.sleep(10_000, controller.signal).then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)

    controller.abort()
    await pending
    expect(resolved).toBe(true)

    // The sleeper was dropped, so advancing past its original dueAt is a no-op
    // (no double-resolve / leaked sleeper).
    clock.advance(20_000)
    expect(clock.now()).toBe(20_000)
  })

  it('resolves immediately when sleep is called with an already-aborted signal', async () => {
    const clock = new FakeClock(0)
    const controller = new AbortController()
    controller.abort()

    await clock.sleep(10_000, controller.signal)
    expect(clock.now()).toBe(0)
  })
})
