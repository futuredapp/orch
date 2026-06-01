// AE10 pin: the `↑/↓` preview cursor skips `▼`/`✓`/`✗` boundary rows; `⏎` on a
// boundary row is a no-op (no `enter` intent). Also covers the
// selection-skip-terminal and selection-skip-empty edge cases the design-lens
// review pinned: when no selectable row exists in the requested direction the
// cursor stays put; when only boundary rows exist `selectedName` is `undefined`
// and every key is a no-op.
//
// These tests drive `useStepsSelection` directly via a thin Harness (same
// pattern as `selection.test.tsx`) so each keystroke is single-shot and
// deterministic — `pressUntilFrame` would walk the cursor too far past the
// AE10 mid-list landing positions.

import { describe, expect, it } from 'bun:test'
import { Box, Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  type StepsSelection,
  StepsView,
  useStepsSelection,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { pressUntilFrame, waitForFrame, waitForIntents } from '../../../../helpers/ink-frame.ts'

const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'
const ENTER = '\r'

// AE10 pane: [parent-A, ▼ sub, child-1, child-2, ✓ sub, parent-B]. The two
// boundary rows split the pane into the three selectable clusters the test
// navigates between.
const PANE_STEPS: readonly StepRow[] = [
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'parent-A',
    startedAt: 0,
    endedAt: 100,
  },
  { kind: 'subworkflow-enter', name: 'sub', depth: 1, glyph: '▼' },
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'child-1',
    startedAt: 100,
    endedAt: 200,
    depth: 1,
  },
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'child-2',
    startedAt: 200,
    endedAt: 300,
    depth: 1,
  },
  { kind: 'subworkflow-exit', name: 'sub', depth: 1, glyph: '✓', durationMs: 200 },
  { kind: 'agent', mode: 'autonomous', status: 'running', name: 'parent-B', startedAt: 300 },
]

interface HarnessHandle {
  readonly selection: StepsSelection
}

// Renders the current selection state as text so frame assertions can pin it
// without depending on the full StepsView render pipeline.
function Harness({
  steps,
  expose,
}: {
  steps: readonly StepRow[]
  expose: (h: HarnessHandle) => void
}): React.ReactElement {
  const sel = useStepsSelection(steps)
  React.useEffect(() => {
    expose({ selection: sel })
  })
  useInput((input, key) => {
    if (key.upArrow) sel.moveUp()
    else if (key.downArrow) sel.moveDown()
    else if (input === 'f') sel.snapToLive()
  })
  return (
    <Box>
      <Text>{`selected=${sel.selectedName ?? 'none'} committed=${sel.committedName ?? 'none'} userDriven=${String(sel.isUserDriven)}`}</Text>
    </Box>
  )
}

function liveState(steps: readonly StepRow[]): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-06-01-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps,
    view: { mode: 'live' },
  }
}

describe('useStepsSelection — boundary-row skip (AE10)', () => {
  it('↑ from the committed live row (parent-B) skips the ✓ exit and lands on child-2', async () => {
    let handle: HarnessHandle | undefined
    const ui = render(<Harness steps={PANE_STEPS} expose={(h) => (handle = h)} />)
    await waitForFrame(ui, (f) => f.includes('selected=parent-B'))

    // Driving the hook directly defeats ink-testing-library's stdin race
    // (useInput's callback can capture a stale closure mid-effect-cycle). We
    // already prove arrow-key delivery wires through to `moveUp/moveDown` in
    // the broader selection.test.tsx — here the assertion is the skip rule.
    handle?.selection.moveUp()
    const frame = await waitForFrame(ui, (f) => f.includes('selected=child-2'))

    expect(frame).toContain('selected=child-2')
    expect(frame).toContain('userDriven=true')

    ui.unmount()
  })

  it('↓ from child-2 skips the ✓ exit and lands on parent-B', async () => {
    let handle: HarnessHandle | undefined
    const ui = render(<Harness steps={PANE_STEPS} expose={(h) => (handle = h)} />)
    await waitForFrame(ui, (f) => f.includes('selected=parent-B'))

    handle?.selection.moveUp()
    await waitForFrame(ui, (f) => f.includes('selected=child-2'))

    handle?.selection.moveDown()
    const frame = await waitForFrame(ui, (f) => f.includes('selected=parent-B'))

    expect(frame).toContain('selected=parent-B')

    ui.unmount()
  })

  it('committedName tracks the most recent selectable row, never a boundary row', async () => {
    const stepsEndingInBoundary: readonly StepRow[] = [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'completed',
        name: 'parent-A',
        startedAt: 0,
        endedAt: 1,
      },
      { kind: 'subworkflow-enter', name: 'sub', depth: 1, glyph: '▼' },
    ]

    const ui = render(<Harness steps={stepsEndingInBoundary} expose={() => {}} />)
    const frame = await waitForFrame(ui, (f) => f.includes('committed='))

    // The trailing ▼ row must NOT be the committed cursor — falls back to the
    // last selectable row (parent-A).
    expect(frame).toContain('committed=parent-A')

    ui.unmount()
  })

  it('selection-skip terminal: ↑ stays put when no selectable row exists above the cursor', async () => {
    const steps: readonly StepRow[] = [
      { kind: 'subworkflow-enter', name: 'outer', depth: 1, glyph: '▼' },
      { kind: 'subworkflow-enter', name: 'inner', depth: 2, glyph: '▼' },
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'completed',
        name: 'leaf',
        startedAt: 0,
        endedAt: 1,
        depth: 2,
      },
      { kind: 'subworkflow-exit', name: 'inner', depth: 2, glyph: '✓', durationMs: 1 },
      { kind: 'subworkflow-exit', name: 'outer', depth: 1, glyph: '✓', durationMs: 1 },
    ]
    const ui = render(<Harness steps={steps} expose={() => {}} />)
    await waitForFrame(ui, (f) => f.includes('selected=leaf'))

    // ↑ from leaf: only boundary rows above — must be a no-op. Re-sending is
    // safe (still a no-op once we're already on leaf with userDriven=false).
    const frame = await pressUntilFrame(
      ui,
      ARROW_UP,
      (f) => f.includes('selected=leaf') && f.includes('userDriven=false'),
    )

    expect(frame).toContain('selected=leaf')
    expect(frame).toContain('userDriven=false')

    ui.unmount()
  })

  it('selection-skip empty: a pane with only boundary rows reports selectedName=none', async () => {
    const steps: readonly StepRow[] = [
      { kind: 'subworkflow-enter', name: 'outer', depth: 1, glyph: '▼' },
      { kind: 'subworkflow-exit', name: 'outer', depth: 1, glyph: '✓', durationMs: 1 },
    ]
    const ui = render(<Harness steps={steps} expose={() => {}} />)
    const frame = await waitForFrame(ui, (f) => f.includes('selected=none'))

    expect(frame).toContain('selected=none')
    expect(frame).toContain('committed=none')

    ui.unmount()
  })
})

describe('<StepsView> Enter on a boundary row is a no-op', () => {
  it('⏎ while the cursor is forced onto a boundary row emits no `enter` intent', async () => {
    const intents: StepsViewIntent[] = []
    // Pane of pure boundary rows — selectedName resolves to `undefined`, so
    // Enter must not produce any intent (the R24 defensive guard).
    const steps: readonly StepRow[] = [
      { kind: 'subworkflow-enter', name: 'sub', depth: 1, glyph: '▼' },
      { kind: 'subworkflow-exit', name: 'sub', depth: 1, glyph: '✓', durationMs: 1 },
    ]

    const ui = render(
      <StepsView state={liveState(steps)} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await waitForFrame(ui, (f) => f.includes('sub'))
    ui.stdin.write(ENTER)

    // Settle delay, then assert no intent was emitted.
    try {
      await waitForIntents(
        () => intents,
        (i) => i.length > 0,
        { timeoutMs: 80 },
      )
      throw new Error('boundary Enter must not emit an intent')
    } catch (err) {
      expect((err as Error).message).toContain('predicate not satisfied')
    }
    expect(intents).toEqual([])

    ui.unmount()
  })
})
