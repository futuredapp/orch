// ---------------------------------------------------------------------------
// steps-view-format — pure row/format helpers shared by the steps-view files.
// ---------------------------------------------------------------------------
//
// Extracted from `steps-view.tsx` so `<StepRow>`, `<SubBoundaryRow>`, the
// header/footer chrome, and the main component can share them without keeping
// the component file over the 300-line ceiling.

import { formatElapsed, stripAnsi } from '../../../observability/index.ts'
import type { StepRow as StepRowData } from './step-types.ts'

export const STEP_NAME_MAX = 30

export type SelectableRow = Exclude<StepRowData, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

// U9: gutter-aware truncation budget for step rows. `effectiveDepth` is the
// row's effective depth after R23 parallel-suppression collapse (a step inside
// a parallel branch already carries `depth: 0` from the projector, so we just
// read `step.depth`). Each `│ ` is 2 chars; floored at 12 so very deep nesting
// doesn't squash the name column to nothing.
export function stepNameBudget(depth: number): number {
  return Math.max(12, STEP_NAME_MAX - 2 * depth)
}

// U9: same budget logic for boundary rows. A depth-d boundary aligns at the
// depth-(d-1) gutter, then `▼ ` / `✓ ` / `✗ ` adds 2 chars before the name —
// total cost works out to `2 * d`, identical to the step-row budget at depth
// d. Pulled out for readability.
export function boundaryNameBudget(depth: number): number {
  return Math.max(12, STEP_NAME_MAX - 2 * depth)
}

// Stacked gutter token, one `│ ` per depth column. The narrow-pane collapse
// path (U9) substitutes a single `│N ` token; see `gutterFor`.
function stackedGutter(depth: number): string {
  if (depth <= 0) return ''
  return '│ '.repeat(depth)
}

// U9 collapse: when the row's LOGICAL depth >= 4 AND paneCols < 60, render the
// compact `│N ` token (e.g. `│4 ` for a depth-4 step, `│3 ` for the matching
// boundary row of a depth-4 sub). The boundary-row case passes `triggerDepth`
// = sub's depth and `renderDepth` = sub's depth - 1 so the boundary aligns at
// one gutter column less than its children — matching the brainstorm rule that
// `▼`/`✓` rows render with (d-1) gutter columns. Step rows pass them equal.
export function gutterFor(depth: number, paneCols: number): string {
  return gutterForRow(depth, depth, paneCols)
}

export function gutterForRow(triggerDepth: number, renderDepth: number, paneCols: number): string {
  if (renderDepth <= 0) return ''
  if (triggerDepth >= 4 && paneCols < 60) return `│${renderDepth} `
  return stackedGutter(renderDepth)
}

// Step rows persist their FULL cache key (e.g. `simple-feature>plan`); the
// visible label strips the sub prefix so the rendered name is just `plan`.
// Used by both step rows and the renderer-side display layer.
export function displayName(name: string): string {
  const idx = name.lastIndexOf('>')
  return idx === -1 ? name : name.slice(idx + 1)
}

// Boundary rows and step rows can share a stable `name` (a sub `simple` and
// some step `simple` are distinct in R20 but indistinguishable by name alone),
// so React keys mix kind + full sub path identity.
export function rowKey(step: StepRowData): string {
  if (step.kind === 'subworkflow-enter') return `enter:${step.subPath.join('>')}`
  if (step.kind === 'subworkflow-exit') return `exit:${step.subPath.join('>')}`
  return step.name
}

export function isSelectableRow(step: StepRowData): step is SelectableRow {
  return step.kind !== 'subworkflow-enter' && step.kind !== 'subworkflow-exit'
}

// Effective depth for memo equality + gutter selection. Reads through the
// optional `depth` field on every variant; absent ⇔ 0 (root).
export function rowDepth(step: StepRowData): number {
  if (step.kind === 'subworkflow-enter' || step.kind === 'subworkflow-exit') return step.depth
  return step.depth ?? 0
}

export function bucketSeconds(now: number, step: SelectableRow): number {
  if (step.startedAt === undefined) return 0
  const end = step.endedAt ?? now
  return Math.round((end - step.startedAt) / 1000)
}

export function formatElapsedFor(step: SelectableRow, now: number): string {
  if (step.startedAt === undefined) return ''
  const end = step.endedAt ?? now
  return formatElapsed(end - step.startedAt)
}

/** Truncated display label for a row, with the gutter budget applied. */
export function rowDisplayLabel(name: string, budget: number): string {
  return truncate(displayName(stripAnsi(name)), budget)
}
