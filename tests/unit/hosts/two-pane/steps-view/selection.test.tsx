// Selection hook tests — mount a tiny test component via ink-testing-library
// and drive it with arrow-key keypresses through the captured stdin.
//
// What this pins:
//   1. ↑ moves selection up; ↓ moves it down.
//   2. `f` snaps back to the live step (and clears `isUserDriven`).
//   3. The hook auto-tracks the live step until the user moves.

import { describe, expect, it } from 'bun:test'
import { Box, Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import type { StepRow } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  type StepsSelection,
  useStepsSelection,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'

const ARROW_UP = '[A'
const ARROW_DOWN = '[B'

// Tick budget mirrors ink-app.test.tsx — Ink's reconciler + useInput
// re-subscribe needs ~30ms to settle on the keypress path.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

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

describe('useStepsSelection', () => {
  it('auto-tracks the live step on first render with isUserDriven=false', async () => {
    let captured: StepsSelection | undefined
    const ui = render(<Harness steps={STEPS} expose={(s) => (captured = s)} />)
    await tick()

    expect(ui.lastFrame()).toContain('selected=work')
    expect(ui.lastFrame()).toContain('userDriven=false')
    expect(captured?.isUserDriven).toBe(false)

    ui.unmount()
  })

  it('moves selection up when the user presses arrow-up and flips isUserDriven=true', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)
    await tick()

    ui.stdin.write(ARROW_UP)
    await tick()

    expect(ui.lastFrame()).toContain('selected=plan')
    expect(ui.lastFrame()).toContain('userDriven=true')

    ui.unmount()
  })

  it('moves selection down when the user presses arrow-down', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)
    await tick()

    ui.stdin.write(ARROW_DOWN)
    await tick()

    expect(ui.lastFrame()).toContain('selected=next')

    ui.unmount()
  })

  it('snaps back to live and clears isUserDriven when the user presses f', async () => {
    const ui = render(<Harness steps={STEPS} expose={() => {}} />)
    await tick()
    ui.stdin.write(ARROW_UP)
    await tick()
    expect(ui.lastFrame()).toContain('userDriven=true')

    ui.stdin.write('f')
    await tick()

    expect(ui.lastFrame()).toContain('selected=work')
    expect(ui.lastFrame()).toContain('userDriven=false')

    ui.unmount()
  })
})
