// ---------------------------------------------------------------------------
// model-ink-harness — a configurable ink render harness for the `model` driver.
// ---------------------------------------------------------------------------
//
// `ink-testing-library`'s `render` hardcodes `columns: 100` and exposes no
// `rows`, so it cannot drive the width-dependent (adaptive columns) or
// height-dependent (scroll viewport) projections U5 must assert at the
// projection seam. This harness is the same shape — a fake stdout/stdin fed to
// Ink with `debug: true` so each frame is written whole — but with SETTABLE
// `columns`/`rows` and a `resize`-style `setSize` that emits the `'resize'`
// event the steps-view hooks listen for. No tmux; no socket. The returned shape
// is a superset of what `waitForFrame`/`pressUntilFrame` consume (`lastFrame()`
// + `stdin.write`), so the existing polling helpers work unchanged.

import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import type { ReactElement } from 'react'

const DEFAULT_COLUMNS = 100
const DEFAULT_ROWS = 24

// A fake stdout whose dimensions are settable and which emits `'resize'` on a
// size change — mirroring a real TTY so `useAdaptiveColumns`/`useStepsScroll`
// re-project. `debug: true` makes Ink write the full frame to `write`, so
// `lastFrame()` is the current frame (same contract as ink-testing-library).
class HarnessStdout extends EventEmitter {
  columns: number
  rows: number
  private _lastFrame: string | undefined

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write = (frame: string): void => {
    this._lastFrame = frame
  }

  lastFrame = (): string | undefined => this._lastFrame

  setSize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

class HarnessStdin extends EventEmitter {
  isTTY = true
  data: string | null = null

  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
}

class HarnessStderr extends EventEmitter {
  write = (): void => {}
}

export interface ModelInkHarness {
  lastFrame(): string | undefined
  readonly stdin: { write(data: string): void }
  /** Re-render at a new geometry, firing `'resize'` so the hooks re-project. */
  setSize(columns: number, rows: number): void
  unmount(): void
}

export interface ModelInkHarnessOptions {
  readonly columns?: number
  readonly rows?: number
}

export function renderModel(
  tree: ReactElement,
  opts: ModelInkHarnessOptions = {},
): ModelInkHarness {
  const stdout = new HarnessStdout(opts.columns ?? DEFAULT_COLUMNS, opts.rows ?? DEFAULT_ROWS)
  const stdin = new HarnessStdin()
  const stderr = new HarnessStderr()
  const instance = inkRender(tree, {
    // The Ink render options accept any Writable/Readable-shaped stream; the
    // fakes implement the subset Ink touches (same approach as ink-testing-library).
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  return {
    lastFrame: () => stdout.lastFrame(),
    stdin,
    setSize: (columns: number, rows: number) => stdout.setSize(columns, rows),
    unmount: () => instance.unmount(),
  }
}
