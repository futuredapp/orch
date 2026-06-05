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

/** Whether `frame` (already stripped) renders a row for `step`. */
export function rowVisible(frame: string, step: string): boolean {
  return frame.split('\n').some((line) => line.includes(step))
}

// --- ANSI escape sequences for keystroke transport (model stdin) -------------
//
// The `model` driver writes raw bytes to ink's fake stdin, so named keys are
// the terminal's own escape sequences. The real-tmux drivers send NamedKeys
// (`Up`/`Down`) through `tmux send-keys` instead — same intent, different
// transport.
export const ARROW_UP = '\u001b[A'
export const ARROW_DOWN = '\u001b[B'

// --- ANSI colour matching (D-P4 — glyph/summary colour, model + screen) ------
//
// A colour assertion proves a production palette choice survives to the frame.
// The co-located colour NAME ('green'/'red'/'yellow') is the independent spec
// (on the Pane Object); this table is the independent spec of how that name
// renders as an SGR parameter. A production change from `green` to `blue` makes
// the rendered byte `34m`, which no longer matches the `32` we look for — the
// test goes RED, never laundered green. Ink emits the basic 16-colour codes for
// named colours, and `tmux capture-pane -e` reproduces them verbatim.
const SGR_PARAM: Record<string, number> = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
}

/**
 * Whether `line` carries an SGR escape that sets foreground `colorName`. Parses
 * every `[...m` sequence and checks its semicolon-separated params for the
 * standalone code — so `[1;32m` (bold green) and `[32m` both match
 * `green`, while `320`/`132` do not.
 */
export function lineHasColor(line: string, colorName: string): boolean {
  const code = SGR_PARAM[colorName]
  if (code === undefined) return false
  const target = String(code)
  const sgr = /\[([0-9;]*)m/g
  for (let m = sgr.exec(line); m !== null; m = sgr.exec(line)) {
    const params = m[1] ?? ''
    if (params.split(';').includes(target)) return true
  }
  return false
}

/** Whether any line containing `needle` also carries the `colorName` SGR code. */
export function frameHasColoredText(frame: string, needle: string, colorName: string): boolean {
  return frame.split('\n').some((line) => line.includes(needle) && lineHasColor(line, colorName))
}
