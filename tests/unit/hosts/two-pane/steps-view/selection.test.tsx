// Selection hook tests — mount a tiny test component via ink-testing-library
// and drive it with arrow-key keypresses through the captured stdin.
//
// What this pins:
//   1. ↑ moves selection up; ↓ moves it down.
//   2. `f` snaps back to the live step (and clears `isUserDriven`).
//   3. The hook auto-tracks the live step until the user moves.
//
// Keypress delivery is racy under ink-testing-library: `useInput` subscribes on
// a mount effect, so a write before that lands is silently dropped, and there
// is no frame-observable signal for the subscription. `pressUntilFrame`
// resends the (idempotent boundary) key until the frame reflects it, which is
// deterministic where a fixed sleep was not (the steps-view flake, 2026-05-26).

import { describe, expect, it } from 'bun:test'
import { Box, Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import type { StepRow } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  type StepsSelection,
  useStepsSelection,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { pressUntilFrame, waitForFrame } from '../../../../helpers/ink-frame.ts'

const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'

const STEPS: readonly StepRow[] = [
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'plan',
    startedAt: 0,
    endedAt: 1,
  },
  { kind: 'agent', mode: 'autonomous', status: 'running', name: 'work', startedAt: 2 },
  { kind: 'agent', mode: 'autonomous', status: 'pending', name: 'next' },
]

/**
 * Tiny harness component: mounts the hook + binds arrow keys / `f` to its
 * actions, then renders the current selection name. The test asserts on
 * `lastFrame()`.
 */
function Harness({
  steps,
  expose,
}: {
  steps: readonly StepRow[]
  expose: (s: StepsSelection) => void
}) {
  const sel = useStepsSelection(steps)
  React.useEffect(() => {
    expose(sel)
  })
  useInput((input, key) => {
    if (key.upArrow) sel.moveUp()
    else if (key.downArrow) sel.moveDown()
    else if (input === 'f') sel.snapToLive()
  })
  return (
    <Box>
      <Text>{`selected=${sel.selectedName ?? 'none'} userDriven=${String(sel.isUserDriven)}`}</Text>
    </Box>
  )
}

// MIGRATED → tests-new/model/selection--auto-tracks-live-and-browses.test.ts
//          + tests-new/screen/selection--highlight-bytes.test.ts  (parent U5a)
describe.skip('useStepsSelection', () => {
  it('auto-tracks the live step on first render with isUserDriven=false', async () => {
    let captured: StepsSelection | undefined
    const ui = render(<Harness steps={STEPS} expose={(s) => (captured = s)} />)
    const frame = await waitForFrame(ui, (f) => f.includes('selected=work'))

    expect(frame).toContain('selected=work')
    expect(frame).toContain('userDriven=false')
    expect(captured?.isUserDriven).toBe(false)

    ui.unmount()
  })

  it('moves selection up when the user presses arrow-up and flips isUserDriven=true', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)

    // `plan` is the top row, so resending ↑ is idempotent once it lands.
    const frame = await pressUntilFrame(ui, ARROW_UP, (f) => f.includes('selected=plan'))

    expect(frame).toContain('selected=plan')
    expect(frame).toContain('userDriven=true')

    ui.unmount()
  })

  it('moves selection down when the user presses arrow-down', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)

    // `next` is the bottom row, so resending ↓ is idempotent once it lands.
    const frame = await pressUntilFrame(ui, ARROW_DOWN, (f) => f.includes('selected=next'))

    expect(frame).toContain('selected=next')

    ui.unmount()
  })

  it('snaps back to live and clears isUserDriven when the user presses f', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)

    await pressUntilFrame(ui, ARROW_UP, (f) => f.includes('userDriven=true'))

    // `f` snaps to the live step; resending it is idempotent (stays on live).
    const frame = await pressUntilFrame(
      ui,
      'f',
      (f) => f.includes('selected=work') && f.includes('userDriven=false'),
    )

    expect(frame).toContain('selected=work')
    expect(frame).toContain('userDriven=false')

    ui.unmount()
  })
})
