// ---------------------------------------------------------------------------
// Frame-text helpers — shared parsing for every driver that reads a steps frame.
// ---------------------------------------------------------------------------
//
// A "frame" is an ANSI-stripped capture of the steps pane: the Ink `lastFrame()`
// on the `model` driver, or `capturePane()` bytes on a real-tmux driver. The
// parsing is identical at every fidelity — only the SOURCE of the frame differs —
// so it lives here once rather than being copy-pasted per driver.

import type { StepStatus } from '../../../src/hosts/two-pane/steps-view/index.ts'
import { stepGlyphView, stripAnsi } from '../../../src/observability/index.ts'
import type { GlyphName } from '../panes/pane-driver.ts'

export { stripAnsi }

// The committed (right-pane-tracking) row renders this cursor glyph. Cyan/bold
// styling is ANSI, stripped from the frame, so the cursor is the only selection
// signal that survives — and the one the user sees.
export const CURSOR = '▌'

// The `↑/↓` preview cursor — the candidate row the user is browsing before
// committing with `Enter`. Rendered only while it differs from the committed
// row (`steps-view.tsx` suppresses `preview` on the committed line), so the two
// glyphs never coincide. Used by the real-tmux navigation protocol to know
// where the cursor currently sits when computing arrow-key deltas.
export const PREVIEW_CURSOR = '›'

const GLYPH_STATUS: Record<GlyphName, StepStatus> = {
  running: 'running',
  done: 'completed',
  failed: 'failed',
}

/** The production glyph char for a semantic `GlyphName` (from `src/`, the oracle). */
export function glyphChar(glyph: GlyphName): string {
  return stepGlyphView(GLYPH_STATUS[glyph]).char
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** The step name on the cursor line, if any of `names` appears after the cursor. */
export function highlightedStepName(frame: string, names: readonly string[]): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.includes(CURSOR)) continue
    const afterCursor = line.slice(line.indexOf(CURSOR) + CURSOR.length)
    const match = names.find((name) => afterCursor.includes(name))
    if (match !== undefined) return match
  }
  return undefined
}

/** The step name on the preview-cursor (`›`) line, if any of `names` follows it. */
export function previewCursorStepName(
  frame: string,
  names: readonly string[],
): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.includes(PREVIEW_CURSOR)) continue
    const afterCursor = line.slice(line.indexOf(PREVIEW_CURSOR) + PREVIEW_CURSOR.length)
    const match = names.find((name) => afterCursor.includes(name))
    if (match !== undefined) return match
  }
  return undefined
}

/** Whether `step`'s row renders `glyph` (step name and glyph on the same line). */
export function rowHasGlyph(frame: string, step: string, glyph: string): boolean {
  return frame.split('\n').some((line) => line.includes(step) && line.includes(glyph))
}

/**
 * The step currently rendering the `running` glyph — the live source the right
 * pane follows. Falls back to `undefined` when nothing is running (a terminal
 * frame), matching the controller's `findLive() ?? lastSelectable` rule.
 */
export function runningStepName(frame: string, names: readonly string[]): string | undefined {
  const glyph = glyphChar('running')
  return names.find((name) => rowHasGlyph(frame, name, glyph))
}
