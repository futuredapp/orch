// ---------------------------------------------------------------------------
// <ViewModeFooter> — the single-line, two-zone live footer below the grid.
// ---------------------------------------------------------------------------
//
// Left zone: the view state — `▶ live`, `⏸ viewing <step>`, and (when
// scrolled) the window range `↑ scrolled 12–28 of 41 · End live`. Right zone:
// the top contextual key hints. Both truncate so the footer is always exactly
// one row — a wrapping footer changes height as its text grows, which tips
// the frame across Ink's fullscreen boundary and triggers a full-clear
// flicker (see steps-view-layout.ts).

import { Box, Text } from 'ink'
import type React from 'react'
import type { ViewMode } from './step-types.ts'
import { STEP_NAME_MAX, truncate } from './steps-view-format.ts'
import { visibleWindowRange } from './steps-view-layout.ts'

export interface ViewModeFooterProps {
  readonly view: ViewMode
  readonly scrollOffset: number
  /** Total step-row count — drives the scrolled `12–28 of 41` indicator. */
  readonly totalSteps: number
  readonly visibleCount: number
}

export function ViewModeFooter({
  view,
  scrollOffset,
  totalSteps,
  visibleCount,
}: ViewModeFooterProps): React.ReactElement {
  return (
    <Box marginTop={1} justifyContent="space-between" gap={2}>
      <Text dimColor wrap="truncate-end">
        {renderFooterState(view, scrollOffset, totalSteps, visibleCount)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {renderFooterHints(view)}
      </Text>
    </Box>
  )
}

/** Left zone — view state. Leads with the scroll indicator when scrolled so
 *  "End live" survives truncation at narrow widths (losing it would strand
 *  the user away from the live tail with no visible way back). */
export function renderFooterState(
  view: ViewMode,
  scrollOffset: number,
  totalSteps: number,
  visibleCount: number,
): string {
  const mode =
    view.mode === 'live' ? '▶ live' : `⏸ viewing ${truncate(view.stepName, STEP_NAME_MAX)}`
  if (scrollOffset <= 0) return mode
  const { start, end } = visibleWindowRange(totalSteps, scrollOffset, visibleCount)
  return `↑ scrolled ${start}–${end} of ${totalSteps} · End live · ${mode}`
}

/** Right zone — key hints. `f` is hidden in live mode: it's a no-op when
 *  already on the most-recent live source. `⇥ pane` trails so it is the
 *  first hint truncation drops at narrow widths. */
export function renderFooterHints(view: ViewMode): string {
  return view.mode === 'live'
    ? '⏎ view step · q quit · ? help · ⇥ pane'
    : 'f live · ⏎ view another · q quit · ? help · ⇥ pane'
}
