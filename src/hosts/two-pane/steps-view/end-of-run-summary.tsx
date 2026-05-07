// ---------------------------------------------------------------------------
// <EndOfRunSummary> — header + footer treatment for terminal run states.
// ---------------------------------------------------------------------------
//
// Phase 4 contract: when the workflow is no longer live (status: completed |
// failed | crashed), the steps-view repaints its header into a summary block
// (totals + duration) and changes the keymap footer copy to lead with `q to
// quit · ⏎ to inspect`. Resume on past interactive steps still works because
// Enter is still wired to the same right-pane controller — this is a pure
// presentation-layer component.
//
// Imported by `steps-view.tsx`; the live frame keeps its current header.

import { Box, Text } from 'ink'
import type React from 'react'
import { formatElapsed } from '../../../observability/index.ts'
import type { RunHeader, EndOfRunSummary as Summary } from './step-types.ts'

export interface EndOfRunSummaryProps {
  readonly run: RunHeader
  readonly summary: Summary
  readonly status: 'completed' | 'failed' | 'crashed'
}

export function EndOfRunSummary({
  run,
  summary,
  status,
}: EndOfRunSummaryProps): React.ReactElement {
  const label = statusLabel(status)
  const duration = formatElapsed(summary.durationMs)
  return (
    <Box flexDirection="column">
      <Text>{`orch · ${run.workflowName} · ${run.runId} · ${label}`}</Text>
      <Text dimColor>
        {`steps ${summary.stepsCompleted}/${summary.stepsTotal} completed`}
        {summary.stepsFailed > 0 ? ` · ${summary.stepsFailed} failed` : ''}
        {` · duration ${duration}`}
      </Text>
    </Box>
  )
}

export interface EndOfRunFooterProps {
  readonly status: 'completed' | 'failed' | 'crashed'
}

/**
 * Footer rendered below the steps list when the run is no longer live. The
 * keymap order leads with `q to quit · ⏎ to inspect` because the user's
 * primary remaining actions are quit-the-TUI and inspect-a-past-step. `f` is
 * still bound but de-emphasized.
 */
export function EndOfRunFooter({ status }: EndOfRunFooterProps): React.ReactElement {
  const label = statusLabel(status)
  return (
    <Box marginTop={1}>
      <Text dimColor>{`run ${label} · q to quit · ⏎ to inspect`}</Text>
    </Box>
  )
}

function statusLabel(status: 'completed' | 'failed' | 'crashed'): string {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  return 'crashed'
}
