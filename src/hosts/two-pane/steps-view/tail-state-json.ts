// ---------------------------------------------------------------------------
// tail-state-json — fs.watch + poll fallback for `state.json`.
// ---------------------------------------------------------------------------
//
// The state store writes via `fs.writeFile(tmp) + rename(tmp, file)`. macOS
// `fs.watch` reports every rename as `'rename'` and the watcher detaches from
// the new inode, so we close + re-open on each change and back the watcher
// up with a 250ms poll loop (Node.js issue #7420).
//
// This tailer is a pure "changed" notifier — the consumer is responsible for
// re-reading + parsing. Decoupling the read from the watch keeps the schema
// surface (StateStore.loadRun) in one place and the watch surface here.
//
// Hybrid debounce: leading-edge fire so the first event is fast; 50ms trailing
// + 200ms max-wait so a burst (10 events in 20ms) coalesces to a single fire.

import { type FSWatcher, watch as fsWatchSync } from 'node:fs'
import type { Path } from '../../../services/types.ts'

export interface TailStateJsonOptions {
  readonly filePath: Path
  /** Called whenever `filePath` changes (after the debounce window). */
  readonly onChange: () => void
  /** Override the poll interval. Default 250ms. */
  readonly pollIntervalMs?: number
  /** Override the trailing-debounce delay. Default 50ms. */
  readonly trailingDebounceMs?: number
  /** Override the max-wait debounce. Default 200ms. */
  readonly maxDebounceMs?: number
}

export interface TailStateJsonHandle {
  /** Fires `onChange` once (so the consumer paints) and installs the watcher. */
  start(): Promise<void>
  stop(): Promise<void>
}

const DEFAULT_POLL_MS = 250
const DEFAULT_TRAILING_MS = 50
const DEFAULT_MAX_DEBOUNCE_MS = 200

export function tailStateJson(opts: TailStateJsonOptions): TailStateJsonHandle {
  let watcher: FSWatcher | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let trailingTimer: NodeJS.Timeout | undefined
  let firstEventAt: number | undefined
  let stopped = false

  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const trailingMs = opts.trailingDebounceMs ?? DEFAULT_TRAILING_MS
  const maxDebounceMs = opts.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS

  const fire = (): void => {
    if (stopped) return
    opts.onChange()
  }

  const scheduleRead = (): void => {
    if (stopped) return
    const now = Date.now()
    if (firstEventAt === undefined) firstEventAt = now
    const elapsed = now - firstEventAt
    if (elapsed >= maxDebounceMs) {
      if (trailingTimer !== undefined) clearTimeout(trailingTimer)
      trailingTimer = undefined
      firstEventAt = undefined
      fire()
      return
    }
    if (trailingTimer !== undefined) clearTimeout(trailingTimer)
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined
      firstEventAt = undefined
      fire()
    }, trailingMs)
    trailingTimer.unref?.()
  }

  const installWatcher = (): void => {
    try {
      watcher = fsWatchSync(opts.filePath, () => {
        scheduleRead()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      watcher = undefined
    }
  }

  const start = async (): Promise<void> => {
    // Leading-edge: fire once on start so the consumer paints without waiting
    // for the first watch event (and so a state.json present at start time is
    // surfaced even when nothing else changes the file).
    fire()
    if (stopped) return
    installWatcher()
    pollTimer = setInterval(() => {
      scheduleRead()
      if (stopped) return
      if (watcher === undefined) installWatcher()
    }, pollMs)
    pollTimer.unref?.()
  }

  const stop = async (): Promise<void> => {
    stopped = true
    if (trailingTimer !== undefined) clearTimeout(trailingTimer)
    trailingTimer = undefined
    watcher?.close()
    watcher = undefined
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
  }

  return { start, stop }
}
