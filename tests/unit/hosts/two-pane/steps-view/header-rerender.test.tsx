// Behavioral test: re-renders + pane resize must not stack breadcrumb headers.
//
// Bug: in production the left-pane steps-view repeatedly prints its
// `orch · <workflow> · <runId>` breadcrumb (with the box's top hairline)
// every time the React tree re-renders at a narrow pane width — leaving a
// stack of stale headers above the live frame. The visible left pane ends
// up looking like:
//
//     orch · tic-tac-toe · r-... ─────
//     orch · tic-tac-toe · r-... ─────
//     orch · tic-tac-toe · r-... ─────
//     (live frame at the bottom)
//
// Triage rule (docs/testing-strategy.md): "would this test still pass if
// the visible pane were empty / wrong?" — we read the screen and assert on
// breadcrumb occurrence count, so no.
//
// Strategy: feed Ink's interactive output through a tiny virtual terminal
// that interprets the ANSI escape sequences Ink emits (cursor up/down,
// erase-in-line, cursor-to-column). The screen state after a state-change +
// resize + state-change sequence must contain the breadcrumb exactly once.

import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import React from 'react'
import type { StepRow, StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

// ---------------------------------------------------------------------------
// Virtual TTY stdout/stdin so Ink's interactive path engages.
// ---------------------------------------------------------------------------

class VirtualStdout extends EventEmitter {
  columns: number
  rows: number
  isTTY = true
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

  setColumns(cols: number): void {
    this.columns = cols
    this.emit('resize')
  }
}

class VirtualStdin extends EventEmitter {
  isTTY = true
  ref(): void {}
  unref(): void {}
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
  read(): null {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tiny VT — replays Ink's ANSI output onto a 2D grid.
// ---------------------------------------------------------------------------

class VirtualTerminal {
  cols: number
  rows: number
  cursorRow = 0
  cursorCol = 0
  private buffer: string[][] = []

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.buffer = this.makeBuffer(cols, rows)
  }

  private makeBuffer(cols: number, rows: number): string[][] {
    const buf: string[][] = []
    for (let r = 0; r < rows; r++) {
      buf.push(new Array(cols).fill(' '))
    }
    return buf
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    for (const row of this.buffer) {
      while (row.length < cols) row.push(' ')
      row.length = cols
    }
    while (this.buffer.length < rows) this.buffer.push(new Array(cols).fill(' '))
    this.buffer.length = rows
    if (this.cursorRow >= rows) this.cursorRow = rows - 1
    if (this.cursorCol > cols) this.cursorCol = cols
  }

  write(data: string): void {
    let i = 0
    while (i < data.length) {
      const c = data[i]
      if (c === '\x1b') {
        i = this.parseEscape(data, i)
        continue
      }
      if (c === '\n') {
        this.cursorRow++
        this.cursorCol = 0
        this.scrollIfNeeded()
        i++
        continue
      }
      if (c === '\r') {
        this.cursorCol = 0
        i++
        continue
      }
      // Skip other C0 controls.
      if (c === undefined || c.charCodeAt(0) < 32) {
        i++
        continue
      }
      if (this.cursorCol >= this.cols) {
        this.cursorRow++
        this.cursorCol = 0
        this.scrollIfNeeded()
      }
      const row = this.buffer[this.cursorRow]
      if (row) row[this.cursorCol] = c
      this.cursorCol++
      i++
    }
  }

  private scrollIfNeeded(): void {
    if (this.cursorRow >= this.rows) {
      this.buffer.push(new Array(this.cols).fill(' '))
      this.buffer.shift()
      this.cursorRow = this.rows - 1
    }
  }

  private parseEscape(data: string, startI: number): number {
    let i = startI + 1
    if (i >= data.length) return i
    const next = data[i]
    if (next !== '[') {
      // ESC + single char (e.g. ESC 7, ESC 8) — consume and ignore.
      return i + 1
    }
    i++ // consume '['
    let params = ''
    while (i < data.length && /[\d;?]/.test(data[i] as string)) {
      params += data[i]
      i++
    }
    if (i >= data.length) return i
    const finalByte = data[i] as string
    i++
    this.handleCSI(finalByte, params)
    return i
  }

  // CSI dispatch table — splitting by handler would obscure the spec mapping.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatch switch
  private handleCSI(finalByte: string, params: string): void {
    if (params.startsWith('?')) {
      // Private modes (cursor visibility, alt-screen, etc.) — visually irrelevant.
      return
    }
    const parts =
      params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)))
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    switch (finalByte) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - (a || 1))
        return
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (a || 1))
        return
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (a || 1))
        return
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - (a || 1))
        return
      case 'E':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (a || 1))
        this.cursorCol = 0
        return
      case 'F':
        this.cursorRow = Math.max(0, this.cursorRow - (a || 1))
        this.cursorCol = 0
        return
      case 'G':
        this.cursorCol = Math.max(0, (a || 1) - 1)
        return
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, (a || 1) - 1)
        this.cursorCol = Math.max(0, (b || 1) - 1)
        return
      case 'K': {
        const row = this.buffer[this.cursorRow]
        if (!row) return
        if (a === 0) for (let c = this.cursorCol; c < this.cols; c++) row[c] = ' '
        else if (a === 1) for (let c = 0; c <= this.cursorCol; c++) row[c] = ' '
        else if (a === 2) for (let c = 0; c < this.cols; c++) row[c] = ' '
        return
      }
      case 'J': {
        if (a === 2) {
          this.buffer = this.makeBuffer(this.cols, this.rows)
        } else if (a === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) {
            const row = this.buffer[this.cursorRow]
            if (row) row[c] = ' '
          }
          for (let r = this.cursorRow + 1; r < this.rows; r++) {
            this.buffer[r] = new Array(this.cols).fill(' ')
          }
        }
        return
      }
      case 'm':
      case 'l':
      case 'h':
        return
      default:
        return
    }
  }

  getScreen(): string {
    return this.buffer.map((row) => row.join('').trimEnd()).join('\n')
  }
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeSteps(count: number): readonly StepRow[] {
  const steps: StepRow[] = []
  for (let i = 0; i < count; i++) {
    steps.push({
      kind: 'agent',
      mode: 'autonomous',
      status: i === count - 1 ? 'running' : 'completed',
      name: `step-${i + 1}`,
      startedAt: i * 1000,
      endedAt: i === count - 1 ? undefined : (i + 1) * 1000,
    })
  }
  return steps
}

function makeState(steps: readonly StepRow[], runId: string): StepsViewState {
  return {
    status: 'live',
    run: { runId, workflowName: 'tic-tac-toe', startedAt: 0 },
    steps,
    view: { mode: 'live' },
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50))
}

function countBreadcrumbs(screen: string, breadcrumbPrefix: string): number {
  const plain = stripAnsi(screen)
  // Strip whitespace inside multi-line wraps so a wrapped breadcrumb still
  // counts. The breadcrumb's stable prefix `orch · tic-tac-toe · r-...` is
  // unique enough to count occurrences directly.
  const compact = plain.replace(/\s+/g, ' ')
  const prefixCompact = breadcrumbPrefix.replace(/\s+/g, ' ')
  let count = 0
  let idx = compact.indexOf(prefixCompact)
  while (idx !== -1) {
    count++
    idx = compact.indexOf(prefixCompact, idx + prefixCompact.length)
  }
  return count
}

describe('<StepsView> header re-render on resize (regression)', () => {
  it('renders the breadcrumb header exactly once after state changes + a pane resize at a narrow width', async () => {
    const stdout = new VirtualStdout(30, 24)
    const stdin = new VirtualStdin()
    const vt = new VirtualTerminal(30, 24)

    const RUN_ID = 'r-2026-05-22-212450-07'
    const BREADCRUMB = `orch · tic-tac-toe · ${RUN_ID}`

    const currentState = makeState(makeSteps(1), RUN_ID)
    let setState: ((next: StepsViewState) => void) | undefined

    const Container = (): React.ReactElement => {
      const [s, set] = React.useState<StepsViewState>(currentState)
      setState = set
      return React.createElement(StepsView, { state: s, onIntent: () => {}, now: () => 5000 })
    }

    const instance = inkRender(React.createElement(Container), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // Matches production (`steps-view-runner.tsx`).
      alternateScreen: true,
    })

    const stateWith = (
      stepCount: number,
      banner?: { text: string; seq: number },
    ): StepsViewState => {
      const base = makeState(makeSteps(stepCount), RUN_ID)
      return banner === undefined
        ? base
        : { ...base, banner: { kind: 'info', text: banner.text, seq: banner.seq, ttlMs: 4000 } }
    }

    try {
      await flush()
      vt.write(stdout.raw)
      stdout.raw = ''

      // Simulate production's interleaved pattern: state changes that toggle
      // a banner on/off (height flips +/-1) AND mid-stream pane resizes.
      let seq = 0
      let stepCount = 1
      // Push state updates with intermittent resizes — output will overflow
      // the small viewport and exercise Ink's clearTerminal + log-update mix.
      const widths = [30, 50, 30, 70, 30, 90, 35]
      for (const w of widths) {
        stdout.setColumns(w)
        vt.resize(w, 24)
        await flush()
        vt.write(stdout.raw)
        stdout.raw = ''

        setState?.(stateWith(++stepCount, { text: `step ${stepCount} running`, seq: ++seq }))
        await flush()
        vt.write(stdout.raw)
        stdout.raw = ''

        setState?.(stateWith(stepCount))
        await flush()
        vt.write(stdout.raw)
        stdout.raw = ''
      }

      const screen = vt.getScreen()
      const occurrences = countBreadcrumbs(screen, BREADCRUMB)

      expect(occurrences).toBe(1)
    } finally {
      instance.unmount()
    }
  }, 10_000)
})
