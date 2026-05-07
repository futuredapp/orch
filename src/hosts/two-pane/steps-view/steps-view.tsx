// ---------------------------------------------------------------------------
// <StepsView> — Ink components for the two-pane left pane.
// ---------------------------------------------------------------------------
//
// Renders a `StepsViewState` plus user-driven selection. Hooks:
//   - `useAdaptiveColumns(stdout)` — width → ColumnSet (debounced re-render)
//   - `useStepsSelection(steps)`  — sticky-on-stepName selection w/ ↑/↓/f
//
// Keymap: `↑/↓` move selection · `⏎` fire intent · `f` snap-to-live ·
// `?` help overlay · `q` quit.
//
// `<StepRow>` is `React.memo`'d with threshold-bucketed prop equality so a
// flood of viewmodel changes (10/sec on a hot step) doesn't redraw every row.

import { Box, Text, useInput } from 'ink'
import type React from 'react'
import { memo, useState } from 'react'
import { formatElapsed, stepGlyph, stripAnsi } from '../../../observability/index.ts'
import type { ColumnSet } from './adaptive-columns.ts'
import { EndOfRunFooter, EndOfRunSummary } from './end-of-run-summary.tsx'
import type { StepRow as StepRowData, StepsViewState } from './step-types.ts'
import { useAdaptiveColumns, useStepsSelection } from './steps-view-hooks.ts'

export type { StepsSelection } from './steps-view-hooks.ts'
export { useAdaptiveColumns, useStepsSelection } from './steps-view-hooks.ts'

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface StepsViewProps {
  readonly state: StepsViewState
  readonly onIntent: (intent: StepsViewIntent) => void
  /**
   * `now()` — used by `<StepRow>` to compute elapsed for live steps. Default
   * `Date.now`. Threading it through props keeps tests deterministic.
   */
  readonly now?: () => number
  /**
   * Optional diagnostic sink: invoked once per Ink keypress with a tagged
   * record. The runner wires this to an NDJSON IPC file so the parent can log
   * keystrokes (debug-only) — without this hook, keypresses inside the Ink
   * child are invisible to anyone debugging the input → intent chain.
   * Default no-op.
   */
  readonly onKey?: (event: StepsViewKeyEvent) => void
}

export type StepsViewIntent =
  | { readonly type: 'enter'; readonly stepName: string }
  | { readonly type: 'follow-live' }
  | { readonly type: 'quit' }

export interface StepsViewKeyEvent {
  readonly ts: number
  readonly key: 'up' | 'down' | 'return' | 'f' | 'q' | '?' | 'esc' | 'other'
  /** Raw input character when `key === 'other'`. Empty string otherwise. */
  readonly input: string
  readonly selectedName: string | undefined
  readonly isUserDriven: boolean
  readonly helpOpen: boolean
}

export function StepsView({
  state,
  onIntent,
  now = Date.now,
  onKey,
}: StepsViewProps): React.ReactElement {
  const columns = useAdaptiveColumns()
  const { selectedName, moveUp, moveDown, snapToLive, isUserDriven } = useStepsSelection(
    state.steps,
  )
  const [helpOpen, setHelpOpen] = useState(false)

  useInput((input, key) => {
    const tag = classifyKey(input, key)
    onKey?.({
      ts: Date.now(),
      key: tag,
      input: tag === 'other' ? input : '',
      selectedName,
      isUserDriven,
      helpOpen,
    })
    if (helpOpen) {
      if (key.escape || input === '?') {
        setHelpOpen(false)
      }
      return
    }
    if (key.upArrow) {
      moveUp()
      return
    }
    if (key.downArrow) {
      moveDown()
      return
    }
    if (key.return) {
      if (selectedName !== undefined) {
        onIntent({ type: 'enter', stepName: selectedName })
      }
      return
    }
    if (input === 'f') {
      snapToLive()
      onIntent({ type: 'follow-live' })
      return
    }
    if (input === 'q') {
      onIntent({ type: 'quit' })
      return
    }
    if (input === '?') {
      setHelpOpen(true)
    }
  })

  const isTerminal = state.status !== 'live'

  return (
    <Box flexDirection="column">
      {isTerminal ? (
        <EndOfRunSummary run={state.run} summary={state.summary} status={state.status} />
      ) : (
        <Text>{renderHeader(state)}</Text>
      )}
      {state.steps.length === 0 ? (
        <Text dimColor>(no steps yet)</Text>
      ) : (
        <Box flexDirection="column">
          {state.steps.map((step) => (
            <StepRow
              key={step.name}
              step={step}
              columns={columns}
              now={now()}
              selected={step.name === selectedName && isUserDriven}
            />
          ))}
        </Box>
      )}
      {isTerminal ? <EndOfRunFooter status={state.status} /> : null}
      {!helpOpen && !isTerminal ? <Keymap /> : null}
      {helpOpen ? <HelpOverlay /> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// <StepRow> — single-step line, memo'd with threshold-bucketed props.
// ---------------------------------------------------------------------------

interface StepRowProps {
  readonly step: StepRowData
  readonly columns: ColumnSet
  readonly now: number
  readonly selected: boolean
}

const StepRow = memo(
  function StepRowImpl({ step, columns, now, selected }: StepRowProps): React.ReactElement {
    const cursor = selected ? '▌' : ' '
    const glyph = stepGlyph(step.status, true)
    const name = stripAnsi(step.name)
    const elapsed = formatElapsedFor(step, now)
    const parts = [`${cursor} ${name}`, glyph]
    if (columns.elapsed && elapsed.length > 0) parts.push(elapsed)
    return <Text>{parts.join('  ')}</Text>
  },
  (prev, next) => {
    if (prev.selected !== next.selected) return false
    if (prev.columns.elapsed !== next.columns.elapsed) return false
    if (prev.step.name !== next.step.name) return false
    if (prev.step.status !== next.step.status) return false
    if (prev.step.kind !== next.step.kind) return false
    if (prev.step.startedAt !== next.step.startedAt) return false
    if (prev.step.endedAt !== next.step.endedAt) return false
    // Bucket elapsed to 1s so a tick that doesn't cross a second boundary
    // doesn't re-render the row.
    return bucketSeconds(prev.now, prev.step) === bucketSeconds(next.now, next.step)
  },
)

function bucketSeconds(now: number, step: StepRowData): number {
  if (step.startedAt === undefined) return 0
  const end = step.endedAt ?? now
  return Math.round((end - step.startedAt) / 1000)
}

function formatElapsedFor(step: StepRowData, now: number): string {
  if (step.startedAt === undefined) return ''
  const end = step.endedAt ?? now
  return formatElapsed(end - step.startedAt)
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

// ---------------------------------------------------------------------------
// <HelpOverlay> + <Keymap>
// ---------------------------------------------------------------------------

export function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold>Keymap</Text>
      <Text>↑/↓ move selection</Text>
      <Text>⏎ replay step in right pane</Text>
      <Text>⏎ disabled while a step is running</Text>
      <Text>f follow live step</Text>
      <Text>? toggle this help</Text>
      <Text>q quit (run continues)</Text>
    </Box>
  )
}

function Keymap(): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>↑/↓ ⏎ f ? q</Text>
    </Box>
  )
}

function renderHeader(state: StepsViewState): string {
  const title = stripAnsi(state.run.workflowName)
  return `orch · ${title} · ${state.run.runId}`
}

interface KeyInfo {
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly return?: boolean
  readonly escape?: boolean
}

function classifyKey(input: string, key: KeyInfo): StepsViewKeyEvent['key'] {
  if (key.upArrow === true) return 'up'
  if (key.downArrow === true) return 'down'
  if (key.return === true) return 'return'
  if (key.escape === true) return 'esc'
  if (input === 'f') return 'f'
  if (input === 'q') return 'q'
  if (input === '?') return '?'
  return 'other'
}

// Hook implementations live in `steps-view-hooks.ts`. Re-exported above for
// callers that import from `index.ts`.
