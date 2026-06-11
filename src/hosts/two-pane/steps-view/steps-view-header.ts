// ---------------------------------------------------------------------------
// steps-view-header — live-header rendering + chrome height estimation.
// ---------------------------------------------------------------------------
//
// The live header is a single (wrapping) text line; the terminal-state header
// is the two-line `<EndOfRunSummary>` block (rendered in `steps-view.tsx`).
// Both heights feed `computeVisibleCount` so the frame never overflows the
// pane viewport (see `steps-view-layout.ts`).

import { stripAnsi } from '../../../observability/index.ts'
import type { StepsViewState } from './step-types.ts'
import { estimateWrappedRows } from './steps-view-layout.ts'

export function renderHeader(state: StepsViewState): string {
  const title = stripAnsi(state.run.workflowName)
  return `orch · ${title} · ${state.run.runId}`
}

/**
 * Wrapped row count of the header block at `columns`. The live header is one
 * (wrapping) line; the terminal-state header is the two-line
 * `<EndOfRunSummary>` block (breadcrumb + status, then the totals line).
 */
export function estimateHeaderRows(state: StepsViewState, columns: number): number {
  if (state.status === 'live') {
    return estimateWrappedRows(renderHeader(state), columns)
  }
  const summary = state.summary
  const breadcrumb = `orch · ${stripAnsi(state.run.workflowName)} · ${state.run.runId} · ${state.status}`
  const totals =
    summary !== undefined
      ? `steps ${summary.stepsCompleted}/${summary.stepsTotal} completed · duration`
      : ''
  return estimateWrappedRows(breadcrumb, columns) + estimateWrappedRows(totals, columns)
}
