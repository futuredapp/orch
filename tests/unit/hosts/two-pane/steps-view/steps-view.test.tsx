// Frame-snapshot tests for `<StepsView>` at width 110.
//
// Use `renderToString` (Ink 7) — synchronous, deterministic, no terminal
// session. ANSI is stripped before snapshotting. We snapshot a few
// representative states (live with a running step, a completed run with a
// summary) — full breakpoint coverage lives in `adaptive-columns.test.ts`.

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import type {
  StepsViewKeyEvent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

const liveState: StepsViewState = {
  status: 'live',
  run: {
    runId: 'r-2026-04-10-458000-q8',
    workflowName: 'demo',
    startedAt: 0,
  },
  steps: [
    {
      kind: 'agent',
      mode: 'autonomous',
      status: 'completed',
      name: 'plan',
      startedAt: 0,
      endedAt: 1_000,
    },
    {
      kind: 'agent',
      mode: 'autonomous',
      status: 'running',
      name: 'work',
      startedAt: 2_000,
    },
  ],
  view: { mode: 'live' },
}

const completedState: StepsViewState = {
  status: 'completed',
  run: liveState.run,
  steps: [
    {
      kind: 'agent',
      mode: 'autonomous',
      status: 'completed',
      name: 'plan',
      startedAt: 0,
      endedAt: 1_000,
    },
  ],
  summary: {
    endedAt: 1_000,
    durationMs: 1_000,
    stepsTotal: 1,
    stepsCompleted: 1,
    stepsFailed: 0,
  },
  view: { mode: 'live' },
}

describe('<StepsView> frame snapshots at width 110', () => {
  it('renders the run header, every step name, and the keymap on a live run', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={liveState} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('orch · demo · r-2026-04-10-458000-q8')
    expect(frame).toContain('plan')
    expect(frame).toContain('work')
    // View-mode footer (live). Replaced the static `↑/↓ ⏎ f ? q` keymap in U4.
    expect(frame).toContain('▶ live')
    expect(frame).toContain('⏎ view step')
    expect(frame).toContain('q quit')
    expect(frame).toContain('? help')
  })

  it('renders the end-of-run footer when the run is no longer live', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={completedState} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('run completed')
    expect(frame).toContain('q to quit')
  })

  it('snapshots a "no steps yet" empty live frame', () => {
    const empty: StepsViewState = { ...liveState, steps: [] }

    const frame = stripAnsi(
      renderToString(<StepsView state={empty} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('(no steps yet)')
  })
})

describe('<StepsView> diagnostic keypress IPC', () => {
  // Tick budget mirrors `selection.test.tsx`: Ink's reconciler + useInput
  // re-subscribe needs ~30ms to settle on the keypress path.
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

  it('invokes onKey for arrow keys, return, f, q, and ?', async () => {
    const events: StepsViewKeyEvent[] = []
    const ui = render(
      <StepsView state={liveState} onIntent={NOOP} now={() => NOW} onKey={(e) => events.push(e)} />,
    )
    await tick()

    ui.stdin.write('[A') // up arrow (ESC[A)
    await tick()
    ui.stdin.write('[B') // down arrow (ESC[B)
    await tick()
    ui.stdin.write('\r') // return
    await tick()
    ui.stdin.write('f')
    await tick()
    ui.stdin.write('?')
    await tick()
    ui.stdin.write('q')
    await tick()

    const tags = events.map((e) => e.key)
    expect(tags).toContain('up')
    expect(tags).toContain('down')
    expect(tags).toContain('return')
    expect(tags).toContain('f')
    expect(tags).toContain('?')
    expect(tags).toContain('q')

    ui.unmount()
  })

  it('captures unknown keys as `other` with the raw input character', async () => {
    const events: StepsViewKeyEvent[] = []
    const ui = render(
      <StepsView state={liveState} onIntent={NOOP} now={() => NOW} onKey={(e) => events.push(e)} />,
    )
    await tick()

    ui.stdin.write('x')
    await tick()

    const other = events.find((e) => e.key === 'other')
    expect(other).toBeDefined()
    expect(other?.input).toBe('x')

    ui.unmount()
  })
})
