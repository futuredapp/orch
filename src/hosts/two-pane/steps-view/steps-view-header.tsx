// ---------------------------------------------------------------------------
// <LiveHeader> — the live-run header block + chrome height estimation.
// ---------------------------------------------------------------------------
//
// Two lines while the run is live:
//   <workflowName bold>  ▶ LIVE   <runId dim>
//   <done>/<total> steps · <elapsed>          (dim)
// The status pill is background-colored; NO_COLOR terminals still read the
// `▶ LIVE` text. The terminal-state header is the `<EndOfRunSummary>` block
// (see `end-of-run-summary.tsx`); both heights feed `computeVisibleCount` so
// the frame never overflows the pane viewport (see `steps-view-layout.ts`).

import { Box, Text } from 'ink'
import type React from 'react'
import { formatElapsed, stripAnsi } from '../../../observability/index.ts'
import type { StepsViewState } from './step-types.ts'
import { isSelectableRow } from './steps-view-format.ts'
import { estimateWrappedRows } from './steps-view-layout.ts'

export function LiveHeader({
  state,
  now,
}: {
  readonly state: StepsViewState
  readonly now: number
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{stripAnsi(state.run.workflowName)}</Text>
        <Text> </Text>
        <Text backgroundColor="green" color="black">
          {' ▶ LIVE '}
        </Text>
        <Text> </Text>
        <Text dimColor>{state.run.runId}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {liveProgressText(state, now)}
      </Text>
    </Box>
  )
}

/** The `<done>/<total> steps · <elapsed>` line — shared with the estimator. */
export function liveProgressText(state: StepsViewState, now: number): string {
  const selectable = state.steps.filter(isSelectableRow)
  const done = selectable.filter((s) => s.status === 'completed' || s.status === 'cached').length
  const elapsed = formatElapsed(Math.max(0, now - state.run.startedAt))
  return `${done}/${selectable.length} steps · ${elapsed}`
}

/**
 * Wrapped row count of the header block at `columns`. The live header is the
 * two-line `<LiveHeader>` block; the terminal-state header is the two-line
 * `<EndOfRunSummary>` block (status line, then the totals line).
 */
export function estimateHeaderRows(state: StepsViewState, columns: number): number {
  if (state.status === 'live') {
    // Both `<LiveHeader>` lines render with `truncate-end`, so each is exactly
    // one row regardless of width.
    return 2
  }
  const summary = state.summary
  const statusLine = `${stripAnsi(state.run.workflowName)} ✗ ${state.status} ${state.run.runId}`
  const totals =
    summary !== undefined
      ? `steps ${summary.stepsCompleted}/${summary.stepsTotal} completed · duration`
      : ''
  return estimateWrappedRows(statusLine, columns) + estimateWrappedRows(totals, columns)
}
