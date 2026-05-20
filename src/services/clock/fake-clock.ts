import type { Clock } from './clock.ts'

interface Sleeper {
  readonly dueAt: number
  readonly resolve: () => void
}

export class FakeClock implements Clock {
  #time: number
  #sleepers: Sleeper[] = []

  constructor(initial = 0) {
    this.#time = initial
  }

  now(): number {
    return this.#time
  }

  sleep(ms: number): Promise<void> {
    if (ms < 0) {
      throw new Error('FakeClock.sleep: ms must be >= 0')
    }
    return new Promise<void>((resolve) => {
      this.#sleepers.push({ dueAt: this.#time + ms, resolve })
    })
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('FakeClock.advance: ms must be >= 0; use set() to move backward')
    }
    this.#time += ms
    this.#drainDueSleepers()
  }

  /** Can move backward; needed for state-replay tests. */
  set(ms: number): void {
    this.#time = ms
    this.#drainDueSleepers()
  }

  #drainDueSleepers(): void {
    // Sort once per drain so resolution order matches dueAt; pending sleepers
    // added during this drain (resolve handlers can schedule new ones) stay in
    // the queue for the next advance().
    const due = this.#sleepers
      .filter((s) => s.dueAt <= this.#time)
      .sort((a, b) => a.dueAt - b.dueAt)
    this.#sleepers = this.#sleepers.filter((s) => s.dueAt > this.#time)
    for (const sleeper of due) sleeper.resolve()
  }
}
