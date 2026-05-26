// Color, bold, and dim assertions for `<StepsView>` rendering.
//
// Bun's test runner reports `process.stdout.isTTY === false`, which causes
// chalk's supports-color detector to return level 0 — Ink then emits no ANSI
// regardless of `color` / `bold` / `dimColor` props. We force chalk level 3
// at module-init time so the un-stripped frames carry real ANSI sequences.
// All other steps-view tests (in sibling files) keep using `stripAnsi` and
// remain unaffected — `stripAnsi` is a no-op on monochrome and stays correct
// on colored output.

import chalk from 'chalk'

chalk.level = 3

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import type { StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

// ANSI escape substrings emitted by chalk at level 3 for the colors and
// styles we care about. Assertions check for presence/absence, not exact
// byte ordering, so Ink emit-order changes don't break the tests.
const CYAN_FG = '\x1b[36m'
const GREEN_FG = '\x1b[32m'
const RED_FG = '\x1b[31m'
const YELLOW_FG = '\x1b[33m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function stateWithSingleStep(
  status: 'completed' | 'running' | 'pending' | 'failed' | 'interactive' | 'cached',
): StepsViewState {
  return {
    status: 'live',
    run: {
      runId: 'r-2026-05-12-000000-aa',
      workflowName: 'demo',
      startedAt: 0,
    },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status,
        name: 'plan',
        startedAt: 0,
        endedAt: status === 'completed' || status === 'failed' ? 1_000 : undefined,
      },
    ],
    view: { mode: 'live' },
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}

// Renders a two-step <StepsView> and presses up-arrow to flip
// `isUserDriven=true` on 'plan' (idx 0). Returns the un-stripped frame so
// callers can assert on ANSI substrings.
async function renderSelectedFrame(
  status: 'completed' | 'running' | 'pending' | 'failed' | 'interactive' | 'cached',
): Promise<string> {
  // Two steps so moveUp() lands on the first (selected) and isUserDriven flips to true.
  const state: StepsViewState = {
    status: 'live',
    run: {
      runId: 'r-2026-05-12-000000-aa',
      workflowName: 'demo',
      startedAt: 0,
    },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status,
        name: 'plan',
        startedAt: 0,
        endedAt: status === 'completed' || status === 'failed' ? 1_000 : undefined,
      },
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'pending',
        name: 'next',
      },
    ],
    view: { mode: 'live' },
  }
  const ui = render(<StepsView state={state} onIntent={NOOP} now={() => NOW} />)
  await tick()
  ui.stdin.write('[A') // up arrow → selection moves up to 'plan', isUserDriven=true
  await tick()
  const frame = ui.lastFrame() ?? ''
  ui.unmount()
  return frame
}

describe('<StepsView> selection accent', () => {
  it('renders cursor and name in cyan on the selected row, with bold name', async () => {
    const frame = await renderSelectedFrame('running')
    const planLine = frame.split('\n').find((line) => line.includes('plan'))
    expect(planLine).toBeDefined()
    if (planLine === undefined) return
    expect(planLine).toContain(CYAN_FG)
    expect(planLine).toContain(BOLD)
    expect(planLine).toContain('▌')
  })

  it('does not put cyan or bold on a row that is neither committed nor previewed', () => {
    // Two steps; the right pane is replaying `plan`, so `plan` is the committed
    // (highlighted) row and `next` is genuinely unselected. With no keypress
    // there is no preview cursor either, so `next` must carry no accent.
    const state: StepsViewState = {
      status: 'live',
      run: { runId: 'r-2026-05-12-000000-aa', workflowName: 'demo', startedAt: 0 },
      steps: [
        { kind: 'agent', mode: 'autonomous', status: 'running', name: 'plan', startedAt: 0 },
        { kind: 'agent', mode: 'autonomous', status: 'pending', name: 'next' },
      ],
      view: { mode: 'replay', stepName: 'plan' },
    }
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    const nextLine = frame.split('\n').find((line) => line.includes('next'))
    expect(nextLine).toBeDefined()
    if (nextLine === undefined) return
    // Unselected row carries neither the cyan accent nor bold, and no marker.
    expect(nextLine).not.toContain(CYAN_FG)
    expect(nextLine).not.toContain(BOLD)
    expect(nextLine).not.toContain('▌')
    expect(nextLine).not.toContain('›')
  })

  it('renders the preview cursor as a bold chevron with no cyan', async () => {
    // Two live steps: committed row is the running `plan` (live). Arrow-up
    // moves the preview cursor up — but `plan` is already top, so the cursor
    // stays on `plan` and coincides with committed. Use a three-step list so
    // the cursor lands on a DISTINCT row.
    const state: StepsViewState = {
      status: 'live',
      run: { runId: 'r-2026-05-12-000000-aa', workflowName: 'demo', startedAt: 0 },
      steps: [
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
      ],
      view: { mode: 'live' },
    }
    const ui = render(<StepsView state={state} onIntent={NOOP} now={() => NOW} />)
    await tick()
    ui.stdin.write('\x1b[A') // preview cursor: work → plan (committed stays on live `work`)
    await tick()
    const frame = ui.lastFrame() ?? ''
    ui.unmount()

    const planLine = frame.split('\n').find((line) => line.includes('plan'))
    expect(planLine).toBeDefined()
    if (planLine === undefined) return
    // Preview cursor: bold `›` chevron, but NO cyan — it is not "what's shown".
    expect(planLine).toContain('›')
    expect(planLine).toContain(BOLD)
    expect(planLine).not.toContain(CYAN_FG)
    expect(planLine).not.toContain('▌')
  })
})

describe('<StepsView> semantic glyph colors', () => {
  it('renders a green check for completed steps', () => {
    const state = stateWithSingleStep('completed')
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    expect(frame).toContain(GREEN_FG)
    expect(frame).toContain('✓')
  })

  it('renders a red cross for failed steps', () => {
    const state = stateWithSingleStep('failed')
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    expect(frame).toContain(RED_FG)
    expect(frame).toContain('✗')
  })

  it('renders a yellow half-circle for running steps', () => {
    const state = stateWithSingleStep('running')
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    expect(frame).toContain(YELLOW_FG)
    expect(frame).toContain('◐')
  })

  it('renders a dim middle dot for pending steps', () => {
    const state = stateWithSingleStep('pending')
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    expect(frame).toContain(DIM)
    expect(frame).toContain('·')
  })

  it('keeps glyph color independent of selection (committed failed row stays red, name turns cyan)', () => {
    // The committed row is the failed step (right pane is replaying it). Its
    // name takes the cyan selection accent while the `✗` glyph keeps its
    // semantic red — the two color spans are independent.
    const state: StepsViewState = {
      status: 'live',
      run: { runId: 'r-2026-05-12-000000-aa', workflowName: 'demo', startedAt: 0 },
      steps: [
        {
          kind: 'agent',
          mode: 'autonomous',
          status: 'failed',
          name: 'plan',
          startedAt: 0,
          endedAt: 1,
        },
      ],
      view: { mode: 'replay', stepName: 'plan' },
    }
    const frame = renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
      columns: 110,
    })
    const planLine = frame.split('\n').find((line) => line.includes('plan'))
    expect(planLine).toBeDefined()
    if (planLine === undefined) return
    expect(planLine).toContain(CYAN_FG) // name accent
    expect(planLine).toContain(RED_FG) // glyph color
    expect(planLine).toContain('✗')
  })
})

describe('<StepsView> NO_COLOR stripped-frame integrity', () => {
  it('retains every structural element (names, glyphs, hairlines, cursor, footer) under stripAnsi', async () => {
    // Reuse renderSelectedFrame to get a frame where the running 'plan' row
    // is user-selected. stripAnsi the result and assert every structural
    // element is still present — color and bold are not load-bearing.
    const coloredFrame = await renderSelectedFrame('running')
    const frame = stripAnsi(coloredFrame)

    expect(frame).toContain('plan') // running step name
    expect(frame).toContain('next') // pending step name
    expect(frame).toContain('◐') // running glyph as plain char
    expect(frame).toContain('·') // pending glyph as plain char
    expect(frame).toMatch(/─{3,}/) // hairlines (box-drawing chars, not ANSI)
    expect(frame).toContain('▌') // selection cursor survives ANSI strip
    expect(frame).toContain('▶ live') // live-mode footer
  })
})
