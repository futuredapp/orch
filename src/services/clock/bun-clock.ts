import type { Clock } from './clock.ts'

export class BunClock implements Clock {
  now(): number {
    return Date.now()
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(id)
        resolve()
      }
      const id = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
