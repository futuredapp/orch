// ---------------------------------------------------------------------------
// steps-view-layout — vertical-fit math for the left pane.
// ---------------------------------------------------------------------------
//
// The left pane is mounted with `alternateScreen: true`. Ink's interactive
// renderer takes a full-screen `clearTerminal` write (a visible blank-then-
// repaint) whenever the rendered frame OVERFLOWS the pane, or crosses the
// fullscreen boundary between two frames (see `Ink.renderInteractiveFrame` →
// `shouldClearTerminalForFrame`). On a narrow pane the chrome around the
// steps grid (a wrapped header, the box borders, the footer + its margin)
// is taller than a naive constant assumes, so the frame overflowed at rest
// and Ink full-cleared on every render — surfacing as the reported "the left
// pane blanks when I scroll" flicker.
//
// `computeVisibleCount` sizes the steps body so the WHOLE frame stays a row
// below the pane's viewport, accounting for the actual wrapped height of the
// chrome plus a one-row safety margin. Keeping the frame strictly under the
// viewport means Ink never takes the clear branch during normal operation.

import { stripAnsi } from '../../../observability/index.ts'
import type { StepRow } from './step-types.ts'

/**
 * Rows a line of text occupies once wrapped to `columns`. An estimate: it uses
 * visible character count rather than Ink's exact word-wrap, which the caller's
 * one-row safety margin absorbs. Always at least 1.
 */
export function estimateWrappedRows(text: string, columns: number): number {
  const width = stripAnsi(text).length
  const cols = Math.max(1, columns)
  return Math.max(1, Math.ceil(width / cols))
}

export interface ChromeRows {
  /** Header/summary text rows above the steps grid. */
  readonly headerRows: number
  /** Banner rows (0 when no banner is shown). */
  readonly bannerRows: number
  /** Footer rows below the grid — single-line, so 1. */
  readonly footerRows: number
}

// The steps grid renders inside a Box with top+bottom hairline borders; the
// footer sits below it with a one-row top margin.
const GRID_BORDERS = 2
const FOOTER_MARGIN = 1
// Keep the frame strictly below the pane viewport so a benign one-row wobble
// (a banner appearing, a wrap rounding) never reaches Ink's fullscreen edge.
const SAFETY_MARGIN = 1

/**
 * Number of step rows the body should render so the whole frame fits within
 * `rows` (the pane height) with a one-row margin to spare. Never below 1.
 */
export function computeVisibleCount(rows: number, chrome: ChromeRows): number {
  const reserved =
    chrome.headerRows +
    chrome.bannerRows +
    GRID_BORDERS +
    FOOTER_MARGIN +
    chrome.footerRows +
    SAFETY_MARGIN
  return Math.max(1, rows - reserved)
}

/**
 * The window of `steps` the body renders: the last `visibleCount` rows,
 * shifted up by `scrollOffset` rows from the bottom of the buffer.
 */
export function visibleSlice(
  steps: readonly StepRow[],
  scrollOffset: number,
  visibleCount: number,
): readonly StepRow[] {
  if (steps.length <= visibleCount) return steps
  const end = steps.length - scrollOffset
  const start = Math.max(0, end - visibleCount)
  return steps.slice(start, end)
}

/**
 * 1-based row range of the rendered window — `{ start: 12, end: 28 }` reads
 * as "rows 12–28 of <total>" in the footer's scroll indicator.
 */
export function visibleWindowRange(
  total: number,
  scrollOffset: number,
  visibleCount: number,
): { readonly start: number; readonly end: number } {
  if (total <= visibleCount) return { start: 1, end: total }
  const end = total - scrollOffset
  return { start: Math.max(1, end - visibleCount + 1), end }
}

/**
 * The scrollbar track for a window of `visibleCount` rows over `total` steps:
 * one char per rendered row, `█` across the thumb and `░` elsewhere. The
 * thumb position mirrors the window's offset from the top of the buffer
 * (offset 0 at the live tail ⇔ thumb at the bottom).
 */
export function scrollbarTrack(
  total: number,
  scrollOffset: number,
  visibleCount: number,
): readonly string[] {
  const rows = Math.min(total, visibleCount)
  if (total <= visibleCount) return Array.from({ length: rows }, () => '█')
  const maxTop = total - visibleCount
  const topIndex = maxTop - scrollOffset
  const thumbSize = Math.max(1, Math.round((visibleCount / total) * visibleCount))
  const travel = visibleCount - thumbSize
  const thumbTop = Math.round((topIndex / maxTop) * travel)
  return Array.from({ length: rows }, (_, i) =>
    i >= thumbTop && i < thumbTop + thumbSize ? '█' : '░',
  )
}
