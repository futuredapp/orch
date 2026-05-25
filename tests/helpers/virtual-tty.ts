// ---------------------------------------------------------------------------
// virtual-tty — a minimal real-TTY stdout/stdin pair for Ink unit tests.
// ---------------------------------------------------------------------------
//
// `ink-testing-library`'s stdout reports `isTTY === undefined` and no `rows`,
// which makes Ink's interactive full-clear branch (`renderInteractiveFrame` →
// `shouldClearTerminalForFrame`) dead code: it early-returns when `!isTty`.
// That is why flicker bugs rooted in Ink's `clearTerminal` write are invisible
// under that harness.
//
// `VirtualStdout` sets `isTTY = true` and carries explicit `rows`/`columns`, so
// Ink takes its real fullscreen/overflow path and we can assert on the bytes it
// would have written to the user's terminal (e.g. `ansi-escapes.clearTerminal`,
// whose unique fingerprint is the erase-scrollback `\x1b[3J`).
//
// `VirtualStdin` follows Ink 7's input path: Ink listens for `'readable'` and
// pulls chunks via `stdin.read()`. Call `stdin.send(input)` to deliver a
// keypress. Wait past Ink's ~200ms kitty-keyboard detection window before
// sending so the probe query doesn't swallow the first keypress.

import { EventEmitter } from 'node:events'

export class VirtualStdout extends EventEmitter {
  columns: number
  rows: number
  isTTY = true
  /** Everything Ink has written so far. Reset to `''` to capture a delta. */
  raw = ''

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write = (data: string | Uint8Array): boolean => {
    this.raw += typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    return true
  }

  setColumns(columns: number): void {
    this.columns = columns
    this.emit('resize')
  }
}

export class VirtualStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null

  ref(): void {}
  unref(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  setRawMode(): void {}

  /** Deliver one keypress to Ink via the `'readable'` + `read()` path. */
  send(input: string): void {
    this.data = input
    this.emit('readable')
  }

  read(): string | null {
    const pending = this.data
    this.data = null
    return pending
  }
}

/** Ink's kitty-keyboard detection listens on stdin for ~200ms after mount. */
export const KITTY_DETECTION_MS = 220
