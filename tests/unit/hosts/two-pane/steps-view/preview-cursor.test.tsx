// triage: keep — Tier 2 projection coverage for the commit-model UX (Issue 2):
// `↑/↓` moves a PREVIEW cursor that is rendered distinctly from the committed
// row the right pane shows, does NOT move the committed `▌` highlight, and does
// NOT swap the right pane (fires no intent). The right pane only follows on
// `Enter`.
//
// Why this satisfies the triage rule: the assertions identify WHICH row carries
// the committed `▌` glyph vs WHICH row carries the preview `›` chevron. A frame
// that drew the cursor on the wrong row, double-marked a row, or moved the
// committed highlight on a plain arrow press fails.

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000
const ARROW_UP = '\x1b[A'
const ENTER = '\r'

// Committed row (= right pane) carries `▌`; the preview cursor carries `›`.
const COMMITTED = '▌'
const PREVIEW = '›'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

function rowWith(frame: string, glyph: string, names: readonly string[]): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.includes(glyph)) continue
    const after = line.slice(line.indexOf(glyph) + glyph.length)
    const match = names.find((name) => after.includes(name))
    if (match !== undefined) return match
  }
  return undefined
}

const STEP_PLAN: StepRow = {
  kind: 'agent',
  mode: 'autonomous',
  status: 'completed',
  name: 'plan',
  startedAt: 0,
  endedAt: 1_000,
}

const STEP_WORK: StepRow = {
  kind: 'agent',
  mode: 'autonomous',
  status: 'running',
  name: 'work',
  startedAt: 2_000,
}

function liveState(steps: readonly StepRow[]): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-25-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps,
    view: { mode: 'live' },
  }
}

const NAMES = ['plan', 'work'] as const

describe('<StepsView> preview cursor (commit model, Issue 2)', () => {
  it('moves a distinct preview cursor on ↑ while leaving the committed highlight on the live step', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView
        state={liveState([STEP_PLAN, STEP_WORK])}
        onIntent={(i) => intents.push(i)}
        now={() => NOW}
      />,
    )
    await tick()

    ui.stdin.write(ARROW_UP) // cursor: work → plan; committed stays on live `work`
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')

    // Committed highlight is unmoved — still the live step the right pane shows.
    expect(rowWith(frame, COMMITTED, NAMES)).toBe('work')
    // Preview cursor sits on the browsed row, rendered with a different glyph.
    expect(rowWith(frame, PREVIEW, NAMES)).toBe('plan')
    // Local navigation must not swap the right pane.
    expect(intents).toEqual([])

    ui.unmount()
  })

  it('does not draw a preview cursor when it coincides with the committed row', async () => {
    const ui = render(
      <StepsView state={liveState([STEP_PLAN, STEP_WORK])} onIntent={NOOP} now={() => NOW} />,
    )
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')

    // At rest the cursor tracks the committed row, so only the committed `▌`
    // marker shows — no redundant `›` chevron.
    expect(rowWith(frame, COMMITTED, NAMES)).toBe('work')
    expect(frame.includes(PREVIEW)).toBe(false)

    ui.unmount()
  })

  it('commits the previewed step (not the committed row) on Enter', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView
        state={liveState([STEP_PLAN, STEP_WORK])}
        onIntent={(i) => intents.push(i)}
        now={() => NOW}
      />,
    )
    await tick()

    ui.stdin.write(ARROW_UP) // preview cursor: work → plan
    await tick()
    ui.stdin.write(ENTER) // commit the browsed row
    await tick()

    // Enter commits the PREVIEW cursor (`plan`), not the live committed row.
    expect(intents).toEqual([{ type: 'enter', stepName: 'plan' }])

    ui.unmount()
  })

  it('snaps the preview cursor back to the committed row on f', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView
        state={liveState([STEP_PLAN, STEP_WORK])}
        onIntent={(i) => intents.push(i)}
        now={() => NOW}
      />,
    )
    await tick()

    ui.stdin.write(ARROW_UP) // preview cursor moves off the committed row
    await tick()
    ui.stdin.write('f') // snap-to-live
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')

    // Cursor rejoined the committed row, so the `›` chevron is gone.
    expect(frame.includes(PREVIEW)).toBe(false)
    expect(rowWith(frame, COMMITTED, NAMES)).toBe('work')
    expect(intents).toEqual([{ type: 'follow-live' }])

    ui.unmount()
  })
})
