// ---------------------------------------------------------------------------
// <ViewModeFooter> — the single-line live footer below the steps grid.
// ---------------------------------------------------------------------------
//
// When `view.mode === 'live'` the footer reads `▶ live · …`; when `'replay'`
// it reads `⏸ viewing <stepName> · f live · …`. When scrolled, the scroll
// indicator leads so it survives single-line truncation at narrow widths.

import { Box, Text } from 'ink'
import type React from 'react'
import type { ViewMode } from './step-types.ts'
import { STEP_NAME_MAX, truncate } from './steps-view-format.ts'

export function ViewModeFooter({
  view,
  scrollOffset,
}: {
  readonly view: ViewMode
  readonly scrollOffset: number
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      {/* Single line: a wrapping footer changes height as its text grows,
          which tips the frame across Ink's fullscreen boundary and triggers a
          full-clear flicker (see steps-view-layout.ts). `truncate-end` keeps
          the line at one row regardless of width. */}
      <Text dimColor wrap="truncate-end">
        {renderViewModeFooter(view, scrollOffset)}
      </Text>
    </Box>
  )
}

export function renderViewModeFooter(view: ViewMode, scrollOffset: number): string {
  // `f` is hidden in live mode — it's a no-op when already on the most-recent
  // live source. Re-introduced when the parallel-switcher UX ships and `f`
  // carries cycle-between-branches semantics.
  const base =
    view.mode === 'live'
      ? '▶ live · ⏎ view step · q quit · ? help'
      : `⏸ viewing ${truncate(view.stepName, STEP_NAME_MAX)} · f live · ⏎ view another · q quit · ? help`
  // Lead with the scroll indicator when scrolled so it survives single-line
  // truncation at narrow widths — losing "End live" would strand the user
  // away from the live tail with no visible way back.
  return scrollOffset > 0 ? `↑ scrolled · End live · ${base}` : base
}
