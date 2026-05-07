// ---------------------------------------------------------------------------
// tail-ndjson — incremental NDJSON tailer with truncation/inode-rotation.
// ---------------------------------------------------------------------------
//
// Watches a single file for appends and emits one event per newline-terminated
// JSON line. Built on `fs.watch` (event-driven) plus a 250ms poll fallback —
// macOS `fs.watch` is famously flaky after atomic renames, so the poll loop
// is the safety net (Node.js issue #7420).
//
// State machine: `{ position, inode, partial, decoder }`. On every read tick:
//   1. stat() the file (ENOENT → reset state and wait for next event)
//   2. if inode changed → file was replaced; reset position to 0
//   3. if size < position → file truncated; reset position to 0
//   4. read [position .. size) into a UTF-8 decoder; emit each `\n`-terminated
//      line through `onLine`. The trailing partial stays buffered for the
//      next tick.
//
// Caps `partial` at 1 MiB to prevent a runaway producer (no `\n` for hours)
// from ballooning memory. On overflow the buffer is dropped + reported via
// `onParseError`. JSON.parse is the caller's job — this tailer only deals
// with line framing.

import { type FSWatcher, watch as fsWatchSync } from 'node:fs'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { FsService } from '../../../services/fs/index.ts'
import type { Path } from '../../../services/types.ts'

export interface TailNdjsonOptions {
  readonly filePath: Path
  /** Optional. Held only as a future-proofing slot so the model can compose
   *  the same FsService into both tailers; this implementation reads via
   *  node:fs/promises directly because line-by-line framing requires
   *  `position`+`size` semantics the FsService port doesn't expose today. */
  readonly fs?: FsService
  readonly onLine: (line: string) => void
  /** Called when the partial-line buffer overflows the cap. */
  readonly onParseError?: (info: {
    readonly message: string
    readonly partialLength: number
  }) => void
  /** Override the polling fallback interval. Default 250ms. */
  readonly pollIntervalMs?: number
  /** Cap for the in-memory partial-line buffer. Default 1 MiB. */
  readonly maxPartialBytes?: number
  /**
   * Byte offset to start reading from. Default 0 (read everything currently
   * in the file plus any subsequent appends). Callers that want to skip
   * pre-existing content set this to the file's size at construction time.
   * Ignored when the file doesn't exist yet — new files always start from 0.
   */
  readonly startOffset?: number
}

export interface TailNdjsonHandle {
  start(): Promise<void>
  stop(): Promise<void>
  /** Current byte offset. Exposed for tests. */
  position(): number
}

const DEFAULT_POLL_MS = 250
const DEFAULT_MAX_PARTIAL = 1 << 20

export function tailNdjson(opts: TailNdjsonOptions): TailNdjsonHandle {
  let position = 0
  let inode: number | undefined
  let partial = ''
  let decoder = new StringDecoder('utf8')
  let watcher: FSWatcher | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let stopped = false
  let reading = false
  let dirty = false
  let initialized = false

  const maxPartial = opts.maxPartialBytes ?? DEFAULT_MAX_PARTIAL
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS

  const reportError = (message: string): void => {
    opts.onParseError?.({ message, partialLength: partial.length })
  }

  const reset = (): void => {
    position = 0
    partial = ''
    decoder = new StringDecoder('utf8')
  }

  const flushLines = (): void => {
    let nl = partial.indexOf('\n')
    while (nl !== -1) {
      const line = partial.slice(0, nl)
      partial = partial.slice(nl + 1)
      if (line.length > 0) opts.onLine(line)
      nl = partial.indexOf('\n')
    }
    if (partial.length > maxPartial) {
      reportError(`partial-line buffer exceeded ${maxPartial} bytes; dropping`)
      partial = ''
      decoder = new StringDecoder('utf8')
    }
  }

  const tickRead = async (): Promise<void> => {
    if (stopped) return
    if (reading) {
      dirty = true
      return
    }
    reading = true
    try {
      do {
        dirty = false
        let size: number
        let ino: number
        try {
          const stats = await fsStat(opts.filePath)
          size = stats.size
          ino = stats.ino
        } catch (err) {
          if (isENOENT(err)) {
            reset()
            inode = undefined
            return
          }
          throw err
        }
        if (inode !== undefined && ino !== inode) {
          reset()
        }
        inode = ino
        if (size < position) reset()
        if (!initialized) {
          // Snap to the requested start offset on the first successful stat.
          // Clamped to [0, size] so a stale offset (file rotated since the
          // caller's stat) reads from the start instead of past EOF.
          const requestedOffset = Math.max(0, opts.startOffset ?? 0)
          position = Math.min(requestedOffset, size)
          initialized = true
        }
        if (size === position) return
        const handle = await fsOpen(opts.filePath, 'r')
        try {
          const toRead = size - position
          const buf = Buffer.alloc(toRead)
          const { bytesRead } = await handle.read(buf, 0, toRead, position)
          position += bytesRead
          partial += decoder.write(buf.subarray(0, bytesRead))
          flushLines()
        } finally {
          await handle.close()
        }
      } while (dirty && !stopped)
    } finally {
      reading = false
    }
  }

  const startWatcher = (): void => {
    try {
      watcher = fsWatchSync(opts.filePath, () => {
        void tickRead()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      // ENOENT — file not present yet; the poll fallback creates the watcher
      // once the file appears.
      watcher = undefined
    }
  }

  const startPolling = (): void => {
    pollTimer = setInterval(() => {
      void tickRead().then(() => {
        if (stopped) return
        if (watcher === undefined) startWatcher()
      })
    }, pollMs)
    pollTimer.unref?.()
  }

  const start = async (): Promise<void> => {
    await tickRead()
    if (stopped) return
    startWatcher()
    startPolling()
  }

  const stop = async (): Promise<void> => {
    stopped = true
    watcher?.close()
    watcher = undefined
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
  }

  return {
    start,
    stop,
    position: () => position,
  }
}

function isENOENT(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'ENOENT'
}
