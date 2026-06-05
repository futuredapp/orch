// ---------------------------------------------------------------------------
// real-tmux PaneDriver — a PaneDriver backed by actual tmux bytes (R5).
// ---------------------------------------------------------------------------
//
// Shared by the `screen` and `full-host` drivers. Every assertion captures the
// pane off real tmux (`PaneHandle.capture()` → ANSI-stripped) and matches it,
// so the full Ink→tmux→capture path is exercised and a production wording typo
// goes RED — a fake tmux could not prove this (parent §5.1, §5.5).
//
// Read assertions are wired here. The two AFFORDANCES (`selectStep` /
// `followLive`) need a navigation protocol over real tmux that no parent-U2
// scenario exercises; they are honestly deferred to the first migration unit
// that navigates over real tmux (parent U4+) via `notImplemented`, so they
// throw loudly rather than passing green.

import type { PaneHandle } from '@orch/test/real-tmux/index.ts'
import { CARET_ECHO_TOKENS, type PaneDriver } from '../panes/pane-driver.ts'
import { notImplemented } from '../not-implemented.ts'
import { glyphChar, highlightedStepName, occurrences, rowHasGlyph } from './frame-text.ts'

export interface RealTmuxPaneDriverDeps {
  /** The handle whose captured bytes back every assertion. */
  readonly handle: PaneHandle
  /** Step names in order — for `assertSelected`. */
  readonly stepNames: () => readonly string[]
  /** Budget for each poll/assert wait (REAL_TMUX_ASSERT_TIMEOUT_MS). */
  readonly assertTimeoutMs: number
  /** Driver label for the deferral message on the affordances. */
  readonly driverLabel: string
}

export function createRealTmuxPaneDriver(deps: RealTmuxPaneDriverDeps): PaneDriver {
  const waitOpts = { timeoutMs: deps.assertTimeoutMs }

  return {
    assertBottomText(literal, { count }): Promise<void> {
      return deps.handle.waitFor((frame) => occurrences(frame, literal) === count, waitOpts)
    },
    assertContains(text): Promise<void> {
      return deps.handle.waitForText(text, waitOpts)
    },
    assertSelected(step): Promise<void> {
      return deps.handle.waitFor(
        (frame) => highlightedStepName(frame, deps.stepNames()) === step,
        waitOpts,
      )
    },
    assertGlyph(step, glyph): Promise<void> {
      const wanted = glyphChar(glyph)
      return deps.handle.waitFor((frame) => rowHasGlyph(frame, step, wanted), waitOpts)
    },
    selectStep(step): Promise<void> {
      return notImplemented(
        `selectStep(${JSON.stringify(step)}) over the ${deps.driverLabel} real-tmux driver`,
      )
    },
    followLive(): Promise<void> {
      return notImplemented(`followLive() over the ${deps.driverLabel} real-tmux driver`)
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
