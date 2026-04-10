import type { Clock } from './clock.ts'

export class SystemClock implements Clock {
  now(): number {
    throw new Error('not implemented')
  }
}
