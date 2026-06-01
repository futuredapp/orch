// triage: keep — Tier 2 projection coverage for the scrollable viewport.
//
// Covers R10/R11/R12 of the scrollable-two-pane plan (U5):
//   - keyboard-driven scroll (j/k, PageUp/Down, Home/End)
//   - viewport stays put when step events arrive mid-scroll (R11 / AE3)
//   - footer carries the scrolled-vs-live-tail indicator (R12 / AE4)
//   - End emits follow-live so the right pane resumes the live source.
//
// Selection movement on ArrowUp/Down is intentionally separate from scroll
// movement (j/k and friends) — the lower-surprise resolution from U5.

import { describe, expect, it } from 'bun:test'
import chalk from 'chalk'
import { render } from 'ink-testing-library'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

chalk.level = 3

const PAGE_UP = '\x1b[5~'
const HOME = '\x1b[H'
const END = '\x1b[F'

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

function manySteps(count: number): readonly StepRow[] {
  const steps: StepRow[] = []
  for (let i = 0; i < count; i++) {
    steps.push({
      kind: 'agent',
      mode: 'autonomous',
      status: i === count - 1 ? 'running' : 'completed',
      name: `step-${String(i).padStart(3, '0')}`,
      startedAt: i * 1_000,
      endedAt: i === count - 1 ? undefined : (i + 1) * 1_000,
    })
  }
  return steps
}

function makeState(steps: readonly StepRow[]): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-21-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps,
    view: { mode: 'live' },
  }
}

describe('<StepsView> scroll viewport', () => {
  it('starts at live tail with no scrolled indicator in the footer', async () => {
    const ui = render(
      <StepsView state={makeState(manySteps(5))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).toContain('▶ live')
    expect(frame).not.toContain('↑ scrolled')
    expect(frame).not.toContain('End live')

    ui.unmount()
  })

  it('k scrolls up and surfaces the scrolled indicator in the footer', async () => {
    const ui = render(
      <StepsView state={makeState(manySteps(60))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('k')
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).toContain('↑ scrolled')
    expect(frame).toContain('End live')

    ui.unmount()
  })

  it('End resets the scroll offset, emits follow-live, and clears the scrolled indicator', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView
        state={makeState(manySteps(60))}
        onIntent={(i) => intents.push(i)}
        now={() => 5_000}
      />,
    )
    await tick()

    ui.stdin.write('k')
    await tick()
    expect(stripAnsi(ui.lastFrame() ?? '')).toContain('↑ scrolled')

    ui.stdin.write(END)
    await tick()

    expect(intents).toContainEqual({ type: 'follow-live' })
    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).not.toContain('↑ scrolled')

    ui.unmount()
  })

  it('PageUp moves the offset further than k (one row vs many)', async () => {
    const ui = render(
      <StepsView state={makeState(manySteps(60))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('k')
    await tick()
    const afterK = stripAnsi(ui.lastFrame() ?? '')
    const stepLinesAfterK = afterK.split('\n').filter((l) => l.includes('step-'))

    ui.stdin.write(PAGE_UP)
    await tick()
    const afterPageUp = stripAnsi(ui.lastFrame() ?? '')
    const stepLinesAfterPageUp = afterPageUp.split('\n').filter((l) => l.includes('step-'))

    // PageUp must have shifted the visible window further back than a single k.
    const firstAfterK = stepLinesAfterK[0] ?? ''
    const firstAfterPageUp = stepLinesAfterPageUp[0] ?? ''
    expect(firstAfterPageUp).not.toEqual(firstAfterK)

    ui.unmount()
  })

  it('Home clamps to the top of the buffer (visible window starts at step-000)', async () => {
    const ui = render(
      <StepsView state={makeState(manySteps(60))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write(HOME)
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).toContain('step-000')
    expect(frame).toContain('↑ scrolled')

    ui.unmount()
  })

  it('scroll offset survives a state-prop change so a new step event does not jerk the viewport (R11/AE3)', async () => {
    const initial = makeState(manySteps(60))
    const ui = render(<StepsView state={initial} onIntent={() => {}} now={() => 5_000} />)
    await tick()

    ui.stdin.write('k')
    ui.stdin.write('k')
    ui.stdin.write('k')
    await tick()
    const beforeNewStep = stripAnsi(ui.lastFrame() ?? '')
    const visibleStepsBefore = beforeNewStep.split('\n').filter((l) => l.includes('step-'))
    const firstBefore = visibleStepsBefore[0] ?? ''

    // Mimic a new step:start event arriving: re-render with one extra step.
    const expanded = makeState([
      ...manySteps(60),
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'running',
        name: 'step-060',
        startedAt: 60_000,
      },
    ])
    ui.rerender(<StepsView state={expanded} onIntent={() => {}} now={() => 5_000} />)
    await tick()

    const afterNewStep = stripAnsi(ui.lastFrame() ?? '')
    const visibleStepsAfter = afterNewStep.split('\n').filter((l) => l.includes('step-'))
    const firstAfter = visibleStepsAfter[0] ?? ''

    // First visible step must match — the viewport stayed put when the new
    // step arrived (no auto-jump-to-tail regression).
    expect(firstAfter).toEqual(firstBefore)
    expect(afterNewStep).toContain('↑ scrolled')

    ui.unmount()
  })

  it('few-step case (steps.length <= visibleCount) does not surface the scrolled indicator after k', async () => {
    const ui = render(
      <StepsView state={makeState(manySteps(3))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('k')
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).not.toContain('↑ scrolled')

    ui.unmount()
  })

  it('ArrowUp/ArrowDown remain pure selection movement and do not surface the scrolled indicator', async () => {
    const ARROW_UP = '\x1b[A'
    const ARROW_DOWN = '\x1b[B'
    const ui = render(
      <StepsView state={makeState(manySteps(60))} onIntent={() => {}} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write(ARROW_UP)
    ui.stdin.write(ARROW_DOWN)
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    expect(frame).not.toContain('↑ scrolled')

    ui.unmount()
  })
})
