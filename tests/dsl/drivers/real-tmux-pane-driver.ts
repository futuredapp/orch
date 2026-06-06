// ---------------------------------------------------------------------------
// real-tmux PaneDriver — a PaneDriver backed by actual tmux bytes (R5).
// ---------------------------------------------------------------------------
//
// Shared by the `screen` and `full-host` drivers. Every assertion captures the
// pane off real tmux (`PaneHandle.capture()` → ANSI-stripped) and matches it,
// so the full Ink→tmux→capture path is exercised and a production wording typo
// goes RED — a fake tmux could not prove this (parent §5.1, §5.5).
//
// The two AFFORDANCES (`selectStep` / `followLive`) drive the committed
// selection over real tmux by sending real keystrokes (parent U4, K1/K3): only
// input the steps view sees is keys, so navigation is arrow-key movement of the
// preview cursor + Enter to commit, and `f` (idempotent) to snap back to live.
// `selectStep` re-captures the frame each move so a dropped keystroke
// self-corrects; `followLive` poll-and-resends `f` until the committed highlight
// lands on the live step (REGRESSION 2026-05-29 nav.f-snaps). Both are bounded by
// the driver's `REAL_TMUX_ASSERT_TIMEOUT_MS` budget. The keystroke transport is
// injected per driver (`screen` → fixture.sendKey; `full-host` → harness.sendKeys).

import type { NamedKey, PaneHandle } from '@orch/test/real-tmux/index.ts'
import { CARET_ECHO_TOKENS, type PaneDriver } from '../panes/pane-driver.ts'
import {
  frameHasColoredText,
  glyphChar,
  highlightedStepName,
  occurrences,
  previewCursorStepName,
  rowHasGlyph,
  rowVisible,
  runningStepName,
} from './frame-text.ts'

// `f` is idempotent w.r.t. the committed live step, so a handful of resends
// safely defeats the dropped-first-keypress race without overshooting.
const FOLLOW_LIVE_MAX_RESENDS = 6

export interface RealTmuxPaneDriverDeps {
  /** The handle whose captured bytes back every assertion. */
  readonly handle: PaneHandle
  /** Step names in order — for `assertSelected` and navigation deltas. */
  readonly stepNames: () => readonly string[]
  /** Budget for each poll/assert wait (REAL_TMUX_ASSERT_TIMEOUT_MS). */
  readonly assertTimeoutMs: number
  /** Driver label for error messages. */
  readonly driverLabel: string
  /** Keystroke transport — sends one key to the steps pane (parent U4, K1). */
  readonly sendKey: (input: NamedKey | string) => Promise<void>
}

export function createRealTmuxPaneDriver(deps: RealTmuxPaneDriverDeps): PaneDriver {
  const waitOpts = { timeoutMs: deps.assertTimeoutMs }
  const committedName = (frame: string): string | undefined =>
    highlightedStepName(frame, deps.stepNames())
  // Where the cursor sits right now: the `↑/↓` preview row if the user has
  // moved it, otherwise the committed row (no preview before the first arrow).
  const cursorName = (frame: string): string | undefined =>
    previewCursorStepName(frame, deps.stepNames()) ?? committedName(frame)

  async function moveCursorTo(step: string): Promise<void> {
    const names = deps.stepNames()
    const target = names.indexOf(step)
    if (target === -1) {
      throw new Error(
        `${deps.driverLabel}: selectStep(${JSON.stringify(step)}) — no such step in ` +
          `[${names.join(', ')}]`,
      )
    }
    // Bounded by the path length plus slack for dropped keystrokes; a hang here
    // is a flake, so it must fail loudly rather than spin.
    let budget = names.length * 2 + 8
    for (;;) {
      const frame = await deps.handle.capture()
      const current = cursorName(frame)
      if (current === step) return
      if (budget-- <= 0) {
        throw new Error(
          `${deps.driverLabel}: selectStep(${JSON.stringify(step)}) — cursor stuck at ` +
            `${JSON.stringify(current ?? '(none)')} after exhausting moves.\nFrame:\n${frame}`,
        )
      }
      const currentIdx = current === undefined ? -1 : names.indexOf(current)
      await deps.sendKey(currentIdx < target ? 'Down' : 'Up')
      // Let the arrow register before re-reading; tolerate a dropped key (the
      // next loop re-captures and resends).
      await deps.handle
        .waitFor((f) => cursorName(f) !== current, { timeoutMs: deps.assertTimeoutMs })
        .catch(() => {})
    }
  }

  // Send an idempotent key (`g`/`G` scroll), re-reading the frame each time, until
  // the predicate holds — defeating the dropped-first-keypress race the same way
  // `followLive` resends `f`. Safe only for keys whose Nth press equals their first.
  async function pollSendKey(
    key: NamedKey | string,
    predicate: (frame: string) => boolean,
  ): Promise<void> {
    const perSend = Math.max(400, Math.floor(deps.assertTimeoutMs / 6))
    for (let i = 0; i < 6; i++) {
      const frame = await deps.handle.capture()
      if (predicate(frame)) return
      await deps.sendKey(key)
      await deps.handle.waitFor(predicate, { timeoutMs: perSend }).catch(() => {})
    }
    await deps.handle.waitFor(predicate, waitOpts)
  }

  return {
    assertBottomText(literal, { count }): Promise<void> {
      return deps.handle.waitFor((frame) => occurrences(frame, literal) === count, waitOpts)
    },
    assertContains(text): Promise<void> {
      return deps.handle.waitForText(text, waitOpts)
    },
    assertSelected(step): Promise<void> {
      return deps.handle.waitFor((frame) => committedName(frame) === step, waitOpts)
    },
    assertGlyph(step, glyph): Promise<void> {
      const wanted = glyphChar(glyph)
      return deps.handle.waitFor((frame) => rowHasGlyph(frame, step, wanted), waitOpts)
    },
    async selectStep(step): Promise<void> {
      await moveCursorTo(step)
      await deps.sendKey('Enter')
      await deps.handle.waitFor((frame) => committedName(frame) === step, waitOpts)
    },
    async followLive(): Promise<void> {
      const names = deps.stepNames()
      // The live source is whichever step renders the `running` glyph right now
      // (in full-host the running step may be the first, not the last); fall back
      // to the last listed step for a synthetic all-complete frame.
      const startFrame = await deps.handle.capture()
      const live = runningStepName(startFrame, names) ?? names[names.length - 1]
      if (live === undefined) {
        throw new Error(`${deps.driverLabel}: followLive() — spec has no live step to follow`)
      }
      const isLive = (frame: string): boolean => committedName(frame) === live
      if (isLive(startFrame)) return
      const perResend = Math.max(500, Math.floor(deps.assertTimeoutMs / FOLLOW_LIVE_MAX_RESENDS))
      for (let i = 0; i < FOLLOW_LIVE_MAX_RESENDS; i++) {
        await deps.sendKey('f')
        try {
          await deps.handle.waitFor(isLive, { timeoutMs: perResend })
          return
        } catch {
          // dropped/late keypress — resend (idempotent on the live step).
        }
      }
      // Final attempt with the full budget so the failure carries a clear frame.
      await deps.handle.waitFor(isLive, waitOpts)
    },
    async browseTo(step): Promise<void> {
      await moveCursorTo(step)
      await deps.handle.waitFor(
        (frame) => previewCursorStepName(frame, deps.stepNames()) === step,
        waitOpts,
      )
    },
    assertPreviewCursorOn(step): Promise<void> {
      return deps.handle.waitFor(
        (frame) => previewCursorStepName(frame, deps.stepNames()) === step,
        waitOpts,
      )
    },
    assertStepVisible(step): Promise<void> {
      return deps.handle.waitFor((frame) => rowVisible(frame, step), waitOpts)
    },
    assertStepOffscreen(step): Promise<void> {
      return deps.handle.waitFor((frame) => !rowVisible(frame, step), waitOpts)
    },
    async openHelp(marker): Promise<void> {
      // `?` toggles the overlay, so it is NOT idempotent — resend only while the
      // marker is still absent (a dropped first keypress), never blind-spam.
      const perSend = Math.max(400, Math.floor(deps.assertTimeoutMs / 6))
      for (let i = 0; i < 6; i++) {
        const frame = await deps.handle.capture()
        if (frame.includes(marker)) return
        await deps.sendKey('?')
        await deps.handle.waitFor((f) => f.includes(marker), { timeoutMs: perSend }).catch(() => {})
      }
      await deps.handle.waitFor((frame) => frame.includes(marker), waitOpts)
    },
    async closeHelp(marker): Promise<void> {
      // `Escape` on a closed overlay is a no-op / banner-dismiss, never a
      // re-open, so it is safe to resend until the marker disappears.
      await pollSendKey('Escape', (frame) => !frame.includes(marker))
    },
    async scrollToOldest(): Promise<void> {
      const oldest = deps.stepNames()[0]
      if (oldest === undefined) return
      // `g` (jump-to-top) is idempotent w.r.t. the oldest row being visible.
      await pollSendKey('g', (frame) => rowVisible(frame, oldest))
    },
    async scrollToLive(): Promise<void> {
      const names = deps.stepNames()
      const live = names[names.length - 1]
      if (live === undefined) return
      await pollSendKey('G', (frame) => rowVisible(frame, live))
    },
    async assertColored(lineNeedle, colorName): Promise<void> {
      // Colour lives in the RAW capture (tmux SGR escapes), so use captureRaw.
      const deadline = Date.now() + deps.assertTimeoutMs
      for (;;) {
        const raw = await deps.handle.captureRaw()
        if (frameHasColoredText(raw, lineNeedle, colorName)) return
        if (Date.now() >= deadline) {
          throw new Error(
            `${deps.driverLabel}: no '${colorName}' SGR on a line containing ` +
              `${JSON.stringify(lineNeedle)}.\nRaw frame:\n${raw}`,
          )
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    assertAbsent(text): Promise<void> {
      return deps.handle.waitFor((frame) => !frame.includes(text), waitOpts)
    },
    async assertNoCaretEcho(): Promise<void> {
      const frame = await deps.handle.capture()
      const offender = CARET_ECHO_TOKENS.find((token) => frame.includes(token))
      if (offender !== undefined) {
        throw new Error(
          `${deps.driverLabel}: pane shows caret-notation echo ${JSON.stringify(offender)} ` +
            `(the legacy pty doubling bug). Captured frame:\n${frame}`,
        )
      }
    },
  }
}
