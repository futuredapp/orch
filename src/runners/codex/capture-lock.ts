import type { CaptureLock } from '../types.ts'

export type { CaptureLock } from '../types.ts'

/**
 * Per-workflow mutex that serializes Codex `thread_id` capture windows. The
 * capture helper diffs `~/.codex/sessions/YYYY/MM/DD/` snapshots against
 * each other; two concurrent captures rooted at the same sessions directory
 * would mis-attribute new files to each other. Holding the lock around the
 * capture window only (release fires as soon as the new file is observed or
 * the timeout fires) keeps the interactive session itself unblocked.
 *
 * The factory shape — `createCaptureLock()` returning an independent instance
 * — exists because module-scoped state poisons `bun test --watch`: a test that
 * acquired and never released would block every subsequent test in the
 * process. Each workflow execution (and each test fixture) creates its own
 * lock; instances do not share state.
 *
 * Calling the returned `release` function more than once is a no-op.
 */
export function createCaptureLock(): CaptureLock {
  // FIFO chain: each acquire awaits the previous owner's release.
  let tail: Promise<void> = Promise.resolve()

  return {
    async acquire(): Promise<() => void> {
      const waitFor = tail
      let released = false
      let releaseFn: () => void = () => {}
      tail = new Promise<void>((resolve) => {
        releaseFn = () => {
          if (released) return
          released = true
          resolve()
        }
      })
      await waitFor
      return releaseFn
    },
  }
}
