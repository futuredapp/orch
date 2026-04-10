import type { Clock } from './clock.ts'

export class FakeClock implements Clock {
  constructor(_initial?: number) {
    throw new Error('not implemented')
  }

  now(): number {
    throw new Error('not implemented')
  }

  advance(_ms: number): void {
    throw new Error('not implemented')
  }

  /** Can move backward; needed for state-replay tests. */
  set(_ms: number): void {
    throw new Error('not implemented')
  }
}
