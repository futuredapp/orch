// `model` category, plain component test (not a `scenario()`): drives
// `<StepsView>` via ink-testing-library — no tmux. Pins the U5/U6 host→CLI
// action channel at the view edge: the interactive `failed` re-entry view
// (`actionsEnabled`) emits `retry` / `retry-continue` intents on `r` / `c`,
// adds the matching footer affordances (AT-3), and stays inert everywhere the
// actions must NOT surface (a completed view, or a failed view with the
// actions disabled — the live-run failure frame, which is the sibling
// feature's territory, out of scope here).

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../src/hosts/two-pane/steps-view/index.ts'
import { waitForFrame, waitForIntents } from '../_support/ink-frame.ts'

const STEPS: readonly StepRow[] = [
  {
    kind: 'agent',
    mode: 'autonomous',
    status: 'completed',
    name: 'plan',
    startedAt: 0,
    endedAt: 1,
  },
  { kind: 'agent', mode: 'autonomous', status: 'failed', name: 'build', startedAt: 1, endedAt: 2 },
]

function terminalState(status: 'completed' | 'failed'): StepsViewState {
  return {
    status,
    run: { runId: 'r-2026-06-09-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: STEPS,
    view: { mode: 'live' },
    summary: {
      endedAt: 2,
      durationMs: 2,
      stepsTotal: 2,
      stepsCompleted: status === 'completed' ? 2 : 1,
      stepsFailed: status === 'failed' ? 1 : 0,
    },
  }
}

// Assert that no intent lands within a short settle budget — the negative the
// gating exists to guarantee. Mirrors the boundary-row no-op test idiom.
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

describe('<StepsView> failure actions — keymap (U5/U6)', () => {
  it('emits a retry intent on `r` in the interactive failed view', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView
        state={terminalState('failed')}
        onIntent={(i) => intents.push(i)}
        actionsEnabled
      />,
    )
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('r')

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'retry' }])

    ui.unmount()
  })

  it('emits a retry-continue intent on `c` in the interactive failed view', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView
        state={terminalState('failed')}
        onIntent={(i) => intents.push(i)}
        actionsEnabled
      />,
    )
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('c')

    await waitForIntents(
      () => intents,
      (i) => i.length > 0,
    )
    expect(intents).toEqual([{ type: 'retry-continue' }])

    ui.unmount()
  })

  it('ignores `r`/`c` in a completed view even with actions enabled', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView
        state={terminalState('completed')}
        onIntent={(i) => intents.push(i)}
        actionsEnabled
      />,
    )
    await waitForFrame(ui, (f) => f.includes('plan'))
    ui.stdin.write('r')
    ui.stdin.write('c')

    await expectNoIntent(intents)

    ui.unmount()
  })

  it('ignores `r`/`c` in a failed view when actions are disabled (live-run failure frame)', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView state={terminalState('failed')} onIntent={(i) => intents.push(i)} />,
    )
    await waitForFrame(ui, (f) => f.includes('build'))
    ui.stdin.write('r')
    ui.stdin.write('c')

    await expectNoIntent(intents)

    ui.unmount()
  })
})

describe('<StepsView> failure actions — footer affordances (AT-3)', () => {
  it('the interactive failed footer adds retry/continue affordances the completed view lacks', async () => {
    const failedUi = render(
      <StepsView state={terminalState('failed')} onIntent={() => {}} actionsEnabled />,
    )
    const failedFrame = await waitForFrame(failedUi, (f) => f.includes('run failed'))
    expect(failedFrame).toContain('r to retry')
    expect(failedFrame).toContain('c to retry & continue')
    // Both views keep inspect (⏎) and quit (q).
    expect(failedFrame).toContain('q to quit')
    expect(failedFrame).toContain('to inspect')
    failedUi.unmount()

    const completedUi = render(
      <StepsView state={terminalState('completed')} onIntent={() => {}} actionsEnabled />,
    )
    const completedFrame = await waitForFrame(completedUi, (f) => f.includes('run completed'))
    expect(completedFrame).not.toContain('r to retry')
    expect(completedFrame).toContain('q to quit')
    completedUi.unmount()
  })

  it('omits the failure affordances when actions are disabled', async () => {
    const ui = render(<StepsView state={terminalState('failed')} onIntent={() => {}} />)
    const frame = await waitForFrame(ui, (f) => f.includes('run failed'))
    expect(frame).not.toContain('r to retry')
    expect(frame).not.toContain('c to retry & continue')
    ui.unmount()
  })
})
