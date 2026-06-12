// `model` category, plain component test (not a `scenario()`): drives
// `<StepsView>` through the renderModel harness at a pinned geometry — no
// tmux. Pins the scroll-follow contract: the ↑/↓ preview cursor can never
// walk OUT of the scrolled window (the reported "my indicator disappears and
// the scrollbar doesn't move" bug). Geometry: 12 rows − 7 chrome rows
// (2 header + 2 grid borders + 1 footer margin + 1 footer + 1 safety) =
// 5 visible step rows over 20 steps.

import { describe, expect, it } from 'bun:test'
import type {
  StepRow,
  StepsViewIntent,
  StepsViewState,
} from '../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../src/observability/index.ts'
import { type WaitForFrameOptions, waitForFrame as waitForFrameRaw } from '../_support/ink-frame.ts'
import { renderModel } from '../dsl/drivers/model-ink-harness.ts'

// Frames carry ANSI codes when an earlier suite file enables chalk colours,
// and the needles here span styled segments (`▌ step-20`) — always strip.
const waitForFrame = (
  ui: { lastFrame(): string | undefined },
  predicate: (frame: string) => boolean,
  opts: WaitForFrameOptions = {},
): Promise<string> => waitForFrameRaw(ui, predicate, { ...opts, transform: stripAnsi })

const ARROW_UP = '\u001B[A'

const STEPS: readonly StepRow[] = Array.from({ length: 20 }, (_, i) => ({
  kind: 'agent',
  mode: 'autonomous',
  status: i === 19 ? 'running' : 'completed',
  name: `step-${i + 1}`,
  startedAt: i,
  ...(i === 19 ? {} : { endedAt: i + 1 }),
}))

const LIVE: StepsViewState = {
  status: 'live',
  run: { runId: 'r-2026-06-11-110000-aa', workflowName: 'scroll-follow', startedAt: 0 },
  steps: STEPS,
  view: { mode: 'live' },
}

function mount(onIntent: (intent: StepsViewIntent) => void = () => {}) {
  return renderModel(<StepsView state={LIVE} onIntent={onIntent} now={() => 30_000} />, {
    columns: 60,
    rows: 12,
  })
}

async function pressUpUntilPreviewOn(
  ui: ReturnType<typeof mount>,
  step: string,
  intermediates: readonly string[],
): Promise<void> {
  for (const name of [...intermediates, step]) {
    ui.stdin.write(ARROW_UP)
    await waitForFrame(ui, (f) => f.includes(`› ${name}`))
  }
}

describe('<StepsView> viewport follows the preview cursor', () => {
  it('scrolls the window up when the cursor crosses its top row', async () => {
    const ui = mount()
    await waitForFrame(ui, (f) => f.includes('▌ step-20'))

    // 4 presses reach the window's top row (step-16); the 5th crosses it.
    await pressUpUntilPreviewOn(ui, 'step-15', ['step-19', 'step-18', 'step-17', 'step-16'])

    const frame = await waitForFrame(ui, (f) => f.includes('↑ scrolled'))
    expect(frame).toContain('› step-15')
    expect(frame).toContain('↑ scrolled 15–19 of 20')
    expect(frame.split('\n').some((line) => line.includes('step-20'))).toBe(false)

    ui.unmount()
  })

  it('pressing f after scrolling away re-pins the window to the live tail', async () => {
    const intents: StepsViewIntent[] = []
    const ui = mount((i) => intents.push(i))
    await waitForFrame(ui, (f) => f.includes('▌ step-20'))

    ui.stdin.write('g')
    await waitForFrame(ui, (f) => f.includes('↑ scrolled 1–5 of 20'))
    ui.stdin.write('f')

    const frame = await waitForFrame(ui, (f) => f.includes('▌ step-20'))
    expect(frame).not.toContain('↑ scrolled')
    expect(intents.filter((i) => i.type === 'follow-live')).toHaveLength(1)

    ui.unmount()
  })

  it('an arrow in a scrolled-away window enters at its edge instead of yanking the viewport back', async () => {
    const ui = mount()
    await waitForFrame(ui, (f) => f.includes('▌ step-20'))

    // Scroll to the oldest steps: the committed cursor (step-20) is now
    // offscreen below the window showing step-1..step-5.
    ui.stdin.write('g')
    await waitForFrame(ui, (f) => f.includes('↑ scrolled 1–5 of 20'))
    ui.stdin.write(ARROW_UP)

    // The cursor enters at the bottom rendered row; the window must not move.
    const frame = await waitForFrame(ui, (f) => f.includes('› step-5'))
    expect(frame).toContain('↑ scrolled 1–5 of 20')

    ui.unmount()
  })
})
