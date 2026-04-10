import type { Clock } from './clock.ts'

export class FakeClock implements Clock {
  #time: number

  constructor(initial = 0) {
    this.#time = initial
  }

  now(): number {
    return this.#time
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('FakeClock.advance: ms must be >= 0; use set() to move backward')
    }
    this.#time += ms
  }

  /** Can move backward; needed for state-replay tests. */
  set(ms: number): void {
    this.#time = ms
  }
}
