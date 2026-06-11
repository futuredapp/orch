// ---------------------------------------------------------------------------
// <StepRow> + <SubBoundaryRow> — the per-row components of the steps grid.
// ---------------------------------------------------------------------------
//
// `<StepRow>` is `React.memo`'d with threshold-bucketed prop equality so a
// flood of viewmodel changes (10/sec on a hot step) doesn't redraw every row.

import { Box, Text } from 'ink'
import type React from 'react'
import { memo } from 'react'
import { formatElapsed, stepGlyphView } from '../../../observability/index.ts'
import type { ColumnSet } from './adaptive-columns.ts'
import type { StepRow as StepRowData } from './step-types.ts'
import {
  boundaryNameBudget,
  bucketSeconds,
  formatElapsedFor,
  gutterFor,
  gutterForRow,
  rowDepth,
  rowDisplayLabel,
  type SelectableRow,
  stepNameBudget,
} from './steps-view-format.ts'

export interface StepRowProps {
  readonly step: SelectableRow
  readonly columns: ColumnSet
  readonly now: number
  /** Committed selection — the row the right pane shows. Drawn `▌` + bold + cyan. */
  readonly selected: boolean
  /** `↑/↓` preview cursor (only when it differs from `selected`). Drawn bold `›`. */
  readonly preview: boolean
  /** Current pane column count — drives U9's depth-overflow collapse rule. */
  readonly paneCols: number
  /**
   * Columns actually available to the row (pane minus the scrollbar column).
   * The selected row pads its highlight to this width so the gray band spans
   * the full row instead of hugging the text.
   */
  readonly rowWidth: number
}

export const StepRow = memo(
  function StepRowImpl({
    step,
    columns,
    now,
    selected,
    preview,
    paneCols,
    rowWidth,
  }: StepRowProps): React.ReactElement {
    // `▌` marks the committed row (= right pane); `›` is the preview cursor the
    // user is browsing with `↑/↓` before committing with `Enter`. They never
    // coincide — the call site suppresses `preview` on the committed row.
    const cursor = selected ? '▌' : preview ? '›' : ' '
    const view = stepGlyphView(step.status)
    const depth = rowDepth(step)
    const gutter = gutterFor(depth, paneCols)
    const name = rowDisplayLabel(step.name, stepNameBudget(depth))
    const elapsed = formatElapsedFor(step, now)
    const showElapsed = columns.elapsed && elapsed.length > 0
    const accent = selected ? 'cyan' : undefined
    const emphasised = selected || preview
    // Full-row background highlight for the committed row. `gray` (bright
    // black) keeps the semantic glyph foreground colors legible on top; the
    // `▌` cursor remains the primary signal for NO_COLOR terminals. The row
    // is padded with trailing spaces to `rowWidth` so the band spans the full
    // row; `truncate-end` guards the frame budget if the width math is ever
    // off by a column (a wrapped row would overflow the measured frame and
    // trigger Ink's full-clear flicker).
    const rowBackground = selected ? 'gray' : undefined
    const contentWidth =
      2 + gutter.length + name.length + 3 + (showElapsed ? 2 + elapsed.length : 0)
    const pad = selected ? Math.max(0, rowWidth - contentWidth) : 0
    return (
      <Text backgroundColor={rowBackground} wrap="truncate-end">
        <Text bold={preview} color={accent}>
          {cursor}
        </Text>
        <Text> </Text>
        {gutter.length > 0 ? <Text dimColor>{gutter}</Text> : null}
        <Text bold={emphasised} color={accent}>
          {name}
        </Text>
        <Text>{'  '}</Text>
        <Text color={view.color} dimColor={view.dim}>
          {view.char}
        </Text>
        {showElapsed ? <Text>{`  ${elapsed}`}</Text> : null}
        {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
      </Text>
    )
  },
  (prev, next) => {
    if (prev.selected !== next.selected) return false
    if (prev.preview !== next.preview) return false
    if (prev.columns.elapsed !== next.columns.elapsed) return false
    if (prev.paneCols !== next.paneCols) return false
    if (prev.rowWidth !== next.rowWidth) return false
    if (prev.step.name !== next.step.name) return false
    if (prev.step.status !== next.step.status) return false
    if (prev.step.kind !== next.step.kind) return false
    if (prev.step.startedAt !== next.step.startedAt) return false
    if (prev.step.endedAt !== next.step.endedAt) return false
    if (rowDepth(prev.step) !== rowDepth(next.step)) return false
    // Bucket elapsed to 1s so a tick that doesn't cross a second boundary
    // doesn't re-render the row.
    return bucketSeconds(prev.now, prev.step) === bucketSeconds(next.now, next.step)
  },
)

// ---------------------------------------------------------------------------
// <SubBoundaryRow> — the `▼ <name>` enter / `✓ <name>` / `✗ <name>` exit row.
// ---------------------------------------------------------------------------
//
// Lives only in the projected state — never persisted, never selectable, never
// the right-pane focus. Renders the gutter at depth-(d-1) so the row aligns
// visually one column to the left of its child steps, matching the brainstorm's
// `▼ outer / │ child / ✓ outer` nesting illustration.

export interface SubBoundaryRowProps {
  readonly row: Extract<StepRowData, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>
  readonly paneCols: number
}

export function SubBoundaryRow({ row, paneCols }: SubBoundaryRowProps): React.ReactElement {
  const gutterDepth = Math.max(0, row.depth - 1)
  const gutter = gutterForRow(row.depth, gutterDepth, paneCols)
  const name = rowDisplayLabel(row.name, boundaryNameBudget(row.depth))
  // Failure color: `✗` glyph is the primary signal. Red is additive — NO_COLOR
  // / color-blind terminals fall back to the glyph alone.
  const isFailure = row.kind === 'subworkflow-exit' && row.glyph === '✗'
  const trailing =
    row.kind === 'subworkflow-exit' && row.durationMs !== undefined
      ? formatElapsed(row.durationMs)
      : '…'
  return (
    <Text>
      <Text> </Text>
      <Text> </Text>
      {gutter.length > 0 ? <Text dimColor>{gutter}</Text> : null}
      <Text color={isFailure ? 'red' : undefined}>{row.glyph}</Text>
      <Text> </Text>
      <Text dimColor>{name}</Text>
      <Text>{'  '}</Text>
      <Text dimColor>{trailing}</Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// <ParallelGroup> — placeholder. Phase 1 doesn't surface parallel branches;
// future phases project parallel-branch-update events into this component.
// ---------------------------------------------------------------------------

export interface ParallelGroupProps {
  readonly parentName: string
  readonly children: readonly StepRowData[]
}

export function ParallelGroup({ parentName, children }: ParallelGroupProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{`▸ ${parentName}`}</Text>
      {children.map((c) => (
        <Text key={c.name}>{`  ├─ ${c.name}`}</Text>
      ))}
    </Box>
  )
}
