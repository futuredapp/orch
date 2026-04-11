import type { Clock } from './clock.ts'

export class BunClock implements Clock {
  now(): number {
    return Date.now()
  }
}
