import type { Clock } from './clock.ts'

export class BunClock implements Clock {
  now(): number {
    return Date.now()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
