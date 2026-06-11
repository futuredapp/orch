// `model` category, plain component test (not a `scenario()`): drives
// `<StepsView>` via ink-testing-library — no tmux. Pins P6's left-pane half
// of the pane-focus hand-off: Tab emits a `focus-pane` intent for the right
// pane (the parent runs `tmux select-pane`), and Tab is swallowed while a
// dialog owns the keyboard. The actual tmux focus change is lifecycle/full-
// host territory; here we pin what the controller is ASKED to do.

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../src/hosts/two-pane/steps-view/index.ts'
import { waitForFrame, waitForIntents } from '../_support/ink-frame.ts'

const TAB = '\t'

const STEPS: readonly StepRow[] = [
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'plan',
    startedAt: 0,
    endedAt: 1,
  },
  { kind: 'agent', mode: 'autonomous', status: 'running', name: 'build', startedAt: 1 },
]

const LIVE: StepsViewState = {
  status: 'live',
  run: { runId: 'r-2026-06-11-110000-aa', workflowName: 'demo', startedAt: 0 },
  steps: STEPS,
  view: { mode: 'live' },
}

describe('<StepsView> pane focus (P6)', () => {
  it('Tab emits a focus-pane intent for the right pane', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={LIVE} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write(TAB)

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'focus-pane', pane: 'right' }])

    ui.unmount()
  })

  it('Tab is swallowed while a dialog is open', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={LIVE} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('?')
    await waitForFrame(ui, (f) => f.includes('Keymap'))
    ui.stdin.write(TAB)

    // Settle budget: no intent may land while the dialog owns the keyboard.
    await new Promise((r) => setTimeout(r, 80))
    expect(intents).toEqual([])

    ui.unmount()
  })
})
