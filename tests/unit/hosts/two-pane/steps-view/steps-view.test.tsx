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
  StepsIntent,
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

describe('<StepsView> hairlines and banner placement', () => {
  it('wraps the steps list in upper and lower hairline rules when steps exist', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={liveState} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    const ruleLines = frame
      .split('\n')
      .filter((line) => /^[─\s]+$/.test(line) && line.includes('─'))
    expect(ruleLines.length).toBeGreaterThanOrEqual(2)
  })

  it('does not render hairlines around the empty state', () => {
    const empty: StepsViewState = { ...liveState, steps: [] }
    const frame = stripAnsi(
      renderToString(<StepsView state={empty} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    const emptyIdx = frame.indexOf('(no steps yet)')
    expect(emptyIdx).toBeGreaterThanOrEqual(0)
    const before = frame.slice(0, emptyIdx)
    const after = frame.slice(emptyIdx + '(no steps yet)'.length)
    // No box-drawing horizontal rule line directly adjacent to the empty-state copy.
    expect(before.split('\n').slice(-2).join('\n')).not.toMatch(/─{3,}/)
    expect(after.split('\n').slice(0, 2).join('\n')).not.toMatch(/─{3,}/)
  })

  it('places the banner above the upper hairline when steps exist', () => {
    const withBanner: StepsViewState = {
      ...liveState,
      banner: { kind: 'info', text: 'snapped to live', seq: 1 },
    }
    const frame = stripAnsi(
      renderToString(<StepsView state={withBanner} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    const bannerIdx = frame.indexOf('snapped to live')
    const firstRuleIdx = frame.search(/─{3,}/)
    expect(bannerIdx).toBeGreaterThanOrEqual(0)
    expect(firstRuleIdx).toBeGreaterThanOrEqual(0)
    expect(bannerIdx).toBeLessThan(firstRuleIdx)
  })

  it('keeps hairlines and drops the elapsed column on narrow terminals (<70 cols)', () => {
    // `useAdaptiveColumns` reads `useStdout().stdout.columns` (a process.stdout
    // proxy under renderToString), not the renderToString `columns` option.
    // Override process.stdout.columns for the duration of this render so
    // pickColumns(60) drops the elapsed column.
    const originalColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true })
    try {
      const frame = stripAnsi(
        renderToString(<StepsView state={liveState} onIntent={NOOP} now={() => NOW} />, {
          columns: 60,
        }),
      )
      const ruleLines = frame
        .split('\n')
        .filter((line) => /^[─\s]+$/.test(line) && line.includes('─'))
      expect(ruleLines.length).toBeGreaterThanOrEqual(2)
      const workRow = frame.split('\n').find((line) => line.includes('work'))
      expect(workRow).toBeDefined()
      expect(workRow).not.toMatch(/\b3s\b/)
    } finally {
      Object.defineProperty(process.stdout, 'columns', {
        value: originalColumns,
        configurable: true,
      })
    }
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

  it('emits the follow-live intent for uppercase F (case-insensitive)', async () => {
    // Reproduces a real failure captured in run r-2026-05-11-215044-tv:
    // the user pressed F (caps-lock) six times to switch back to the live
    // step; tui-keys.ndjson recorded `{"key":"other","input":"F",...}` each
    // time and tui-intents.ndjson contained zero follow-live entries. The
    // shortcut is advertised as "f live" in the footer — uppercase must work.
    const intents: StepsIntent[] = []
    const ui = render(
      <StepsView state={liveState} onIntent={(i) => intents.push(i)} now={() => NOW} />,
    )
    await tick()

    ui.stdin.write('F')
    await tick()

    expect(intents).toContainEqual({ type: 'follow-live' })

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
