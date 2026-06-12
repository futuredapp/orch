// `model` category, plain component test (not a `scenario()`): drives
// `<StepsView>` via ink-testing-library — no tmux. Pins the P4 dialog layer:
// `q` on a LIVE run opens the confirm-quit dialog (Esc stays, a second `q` or
// ⏎ on the focused quit button quits); `a` on the interactive failed view
// opens the failure-actions dialog whose buttons emit the same intents as the
// `r`/`c` chords. While a dialog is open it replaces the steps grid (content
// replacement, no frame growth) and the steps keymap is swallowed.

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../src/hosts/two-pane/steps-view/index.ts'
import { waitForFrame, waitForIntents } from '../_support/ink-frame.ts'

const ESC = '\u001B'
const ENTER = '\r'
const ARROW_RIGHT = '\u001B[C'

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

function liveState(): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-06-11-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: STEPS,
    view: { mode: 'live' },
  }
}

function failedState(): StepsViewState {
  return {
    status: 'failed',
    run: { runId: 'r-2026-06-11-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      STEPS[0] as StepRow,
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'failed',
        name: 'build',
        startedAt: 1,
        endedAt: 2,
      },
    ],
    view: { mode: 'live' },
    summary: { endedAt: 2, durationMs: 2, stepsTotal: 2, stepsCompleted: 1, stepsFailed: 1 },
  }
}

async function expectNoIntent(intents: readonly StepsViewIntent[]): Promise<void> {
  try {
    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
      { timeoutMs: 80 },
    )
    throw new Error(`expected no intent, got ${JSON.stringify(intents)}`)
  } catch (err) {
    expect((err as Error).message).toContain('predicate not satisfied')
  }
}

describe('<StepsView> confirm-quit dialog (P4)', () => {
  it('q on a live run opens the confirm dialog instead of quitting', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={liveState()} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('q')

    await waitForFrame(ui, (f) => f.includes('Quit orch viewer?'))
    await expectNoIntent(intents)

    ui.unmount()
  })

  it('Esc in the confirm dialog stays — the dialog closes and the grid returns', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={liveState()} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('q')
    await waitForFrame(ui, (f) => f.includes('Quit orch viewer?'))
    ui.stdin.write(ESC)

    const frame = await waitForFrame(ui, (f) => !f.includes('Quit orch viewer?'))
    expect(frame).toContain('build')
    await expectNoIntent(intents)

    ui.unmount()
  })

  it('a second q confirms the quit', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={liveState()} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('q')
    await waitForFrame(ui, (f) => f.includes('Quit orch viewer?'))
    ui.stdin.write('q')

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'quit' }])

    ui.unmount()
  })

  it('Enter on the focused quit button quits; arrowing to stay and Enter does not', async () => {
    const quitIntents: StepsViewIntent[] = []
    const quitUi = render(<StepsView state={liveState()} onIntent={(i) => quitIntents.push(i)} />)
    await waitForFrame(quitUi, (f) => f.includes('build'))
    quitUi.stdin.write('q')
    await waitForFrame(quitUi, (f) => f.includes('Quit orch viewer?'))
    quitUi.stdin.write(ENTER)
    await waitForIntents(
      () => quitIntents,
      (i) => i.length > 0,
    )
    expect(quitIntents).toEqual([{ type: 'quit' }])
    quitUi.unmount()

    const stayIntents: StepsViewIntent[] = []
    const stayUi = render(<StepsView state={liveState()} onIntent={(i) => stayIntents.push(i)} />)
    await waitForFrame(stayUi, (f) => f.includes('build'))
    stayUi.stdin.write('q')
    await waitForFrame(stayUi, (f) => f.includes('Quit orch viewer?'))
    stayUi.stdin.write(ARROW_RIGHT)
    await waitForFrame(stayUi, (f) => f.includes('❯ stay'))
    stayUi.stdin.write(ENTER)
    const frame = await waitForFrame(stayUi, (f) => !f.includes('Quit orch viewer?'))
    expect(frame).toContain('build')
    await expectNoIntent(stayIntents)
    stayUi.unmount()
  })

  it('q on a terminal run quits immediately without a dialog', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(<StepsView state={failedState()} onIntent={(i) => intents.push(i)} />)
    await waitForFrame(ui, (f) => f.includes('run failed'))
    ui.stdin.write('q')

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'quit' }])

    ui.unmount()
  })
})

describe('<StepsView> failure-actions dialog (P4)', () => {
  it('a on the interactive failed view opens the actions dialog', async () => {
    const ui = render(<StepsView state={failedState()} onIntent={() => {}} actionsEnabled />)
    await waitForFrame(ui, (f) => f.includes('run failed'))
    ui.stdin.write('a')

    await waitForFrame(ui, (f) => f.includes('Step failed — choose an action'))

    ui.unmount()
  })

  it('Enter on the focused retry button emits the retry intent and closes the dialog', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView state={failedState()} onIntent={(i) => intents.push(i)} actionsEnabled />,
    )
    await waitForFrame(ui, (f) => f.includes('run failed'))
    ui.stdin.write('a')
    await waitForFrame(ui, (f) => f.includes('Step failed — choose an action'))
    ui.stdin.write(ENTER)

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'retry' }])
    await waitForFrame(ui, (f) => !f.includes('Step failed — choose an action'))

    ui.unmount()
  })

  it('arrowing to retry & continue and Enter emits the retry-continue intent', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView state={failedState()} onIntent={(i) => intents.push(i)} actionsEnabled />,
    )
    await waitForFrame(ui, (f) => f.includes('run failed'))
    ui.stdin.write('a')
    await waitForFrame(ui, (f) => f.includes('Step failed — choose an action'))
    ui.stdin.write(ARROW_RIGHT)
    await waitForFrame(ui, (f) => f.includes('❯ retry & continue'))
    ui.stdin.write(ENTER)

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'retry-continue' }])

    ui.unmount()
  })

  it('a stays inert without actionsEnabled', async () => {
    const ui = render(<StepsView state={failedState()} onIntent={() => {}} />)
    await waitForFrame(ui, (f) => f.includes('run failed'))
    ui.stdin.write('a')

    // Settle budget: the dialog must NOT appear.
    await new Promise((r) => setTimeout(r, 80))
    expect(ui.lastFrame() ?? '').not.toContain('Step failed — choose an action')

    ui.unmount()
  })
})
