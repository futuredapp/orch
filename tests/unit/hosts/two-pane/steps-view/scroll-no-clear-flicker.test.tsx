// COVERED BY → tests-new/screen/scroll--window-bytes.test.ts (parent U14 group-B closeout) — every case covered; see ledger. Kept skipped on disk (D2).
// Behavioral regression: scrolling the left pane must not blank it.
//
// Bug (docs/findings/2026-05-25-issue-1-left-pane-blanks-on-nav.md): at a
// narrow pane width the steps-view frame is sized to fill — and at narrow
// widths actually OVERFLOW — the pane, so it sits on Ink's fullscreen
// boundary. A navigation keypress that nudges the frame height by one row
// (the footer gaining its `↑ scrolled · End live` hint) tips Ink into its
// full-screen `clearTerminal` write, which wipes the pane and repaints it —
// the reported "left panel blanks when I scroll" flicker.
//
// `ansi-escapes.clearTerminal` is `\x1b[2J\x1b[3J\x1b[H`. The erase-scrollback
// `\x1b[3J` is its unique fingerprint: Ink emits it ONLY on the full-clear
// branch, never on the in-place `log-update` (eraseLines) path and never from
// a plain keypress. So "the keypress write contains `\x1b[3J`" == "the pane
// blanked". We assert it does not.
//
// Triage rule (docs/testing-strategy.md): would this still pass if the pane
// were empty/wrong? No — it asserts on the exact write a scroll keypress
// produces, which is the flicker itself.

import { describe, expect, it } from 'bun:test'
import { render as inkRender } from 'ink'
import React from 'react'
import type { StepRow, StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'
import { KITTY_DETECTION_MS, VirtualStdin, VirtualStdout } from '../../../../helpers/virtual-tty.ts'

const ERASE_SCROLLBACK = '\x1b[3J'

function makeSteps(count: number): readonly StepRow[] {
  const steps: StepRow[] = []
  for (let i = 0; i < count; i++) {
    steps.push({
      kind: 'agent',
      mode: 'autonomous',
      status: i === count - 1 ? 'running' : 'completed',
      name: `step-${i + 1}`,
      startedAt: i * 1_000,
      endedAt: i === count - 1 ? undefined : (i + 1) * 1_000,
    })
  }
  return steps
}

function liveState(stepCount: number): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-25-120000-aa', workflowName: 'tic-tac-toe', startedAt: 0 },
    steps: makeSteps(stepCount),
    view: { mode: 'live' },
  }
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Mounted {
  readonly stdout: VirtualStdout
  readonly stdin: VirtualStdin
  rerender(state: StepsViewState): void
  unmount(): void
}

// A pane small enough that the frame sits at Ink's fullscreen boundary, and
// narrow enough (30 cols) that the header and the footer's scroll hint wrap.
function mountNarrowPane(state: StepsViewState): Mounted {
  const stdout = new VirtualStdout(30, 12)
  const stdin = new VirtualStdin()
  const instance = inkRender(
    React.createElement(StepsView, { state, onIntent: () => {}, now: () => 5_000 }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  )
  return {
    stdout,
    stdin,
    rerender: (next) =>
      instance.rerender(
        React.createElement(StepsView, { state: next, onIntent: () => {}, now: () => 5_000 }),
      ),
    unmount: () => instance.unmount(),
  }
}

describe.skip('<StepsView> scroll does not blank the pane', () => {
  it('does not emit a full-screen clearTerminal when a scroll-up keypress is pressed at a narrow pane width', async () => {
    const pane = mountNarrowPane(liveState(10))

    try {
      await settle(KITTY_DETECTION_MS + 40)
      pane.stdout.raw = '' // discard the mount frame; capture only the keypress write

      pane.stdin.send('k') // scroll up one row → footer gains its scrolled indicator
      await settle()

      expect(pane.stdout.raw).not.toContain(ERASE_SCROLLBACK)
    } finally {
      pane.unmount()
    }
  }, 10_000)

  it('stays flicker-free across repeated scroll keypresses', async () => {
    const pane = mountNarrowPane(liveState(10))

    try {
      await settle(KITTY_DETECTION_MS + 40)
      pane.stdout.raw = ''

      for (let i = 0; i < 4; i++) {
        pane.stdin.send('k')
        await settle()
      }

      expect(pane.stdout.raw).not.toContain(ERASE_SCROLLBACK)
    } finally {
      pane.unmount()
    }
  }, 10_000)

  it('does not blank the pane when a banner appears or disappears mid-run', async () => {
    const pane = mountNarrowPane(liveState(10))

    try {
      await settle(KITTY_DETECTION_MS + 40)
      pane.stdout.raw = ''

      pane.rerender({
        ...liveState(10),
        banner: { kind: 'info', text: 'step 7 running', seq: 1, ttlMs: 4_000 },
      })
      await settle()
      pane.rerender(liveState(10)) // banner clears
      await settle()

      expect(pane.stdout.raw).not.toContain(ERASE_SCROLLBACK)
    } finally {
      pane.unmount()
    }
  }, 10_000)

  it('keeps the scrolled / End-live indicator visible at a narrow width', async () => {
    const pane = mountNarrowPane(liveState(10))

    try {
      await settle(KITTY_DETECTION_MS + 40)
      pane.stdout.raw = ''

      pane.stdin.send('k')
      await settle()

      const screen = stripAnsi(pane.stdout.raw)
      expect(screen).toContain('↑ scrolled')
      expect(screen).toContain('End live')
    } finally {
      pane.unmount()
    }
  }, 10_000)
})
