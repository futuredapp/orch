// Phase 4 unit tests: <EndOfRunSummary> + <EndOfRunFooter>.
//
// Pins the contract that:
//   1. The header repaints to a summary block on completed/failed/crashed.
//   2. The footer copy leads with `q to quit · ⏎ to inspect`.
//   3. Selection keeps working in the terminal-state frame (resume on a past
//      interactive step still fires onIntent('enter')).
//   4. The live → ended transition is single-shot (re-render with the same
//      terminal state produces the same frame; no flicker on coalesced
//      writes).

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import {
  EndOfRunFooter,
  EndOfRunSummary,
  StepsView,
  type StepsViewIntent,
  type StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const RUN = {
  runId: 'r-2026-04-10-458000-q8',
  workflowName: 'demo',
  startedAt: 0,
}

const SUMMARY = {
  endedAt: 5_000,
  durationMs: 5_000,
  stepsTotal: 3,
  stepsCompleted: 2,
  stepsFailed: 1,
}

const ENDED_STATE: StepsViewState = {
  status: 'completed',
  run: RUN,
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
      mode: 'interactive',
      status: 'completed',
      name: 'brainstorm',
      startedAt: 1_000,
      endedAt: 4_000,
      sessionId: 'sess-1',
    },
  ],
  summary: { ...SUMMARY, stepsTotal: 2, stepsCompleted: 2, stepsFailed: 0 },
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

describe('EndOfRunSummary header repaint', () => {
  it('repaints the header into a summary block on completion (totals + duration)', () => {
    const frame = stripAnsi(
      renderToString(<EndOfRunSummary run={RUN} summary={SUMMARY} status="completed" />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('demo')
    expect(frame).toContain('completed')
    expect(frame).toContain('steps 2/3 completed')
    expect(frame).toContain('1 failed')
    expect(frame).toContain('duration')
  })

  it('renders distinct labels for failed and crashed terminal states', () => {
    const failed = stripAnsi(
      renderToString(<EndOfRunSummary run={RUN} summary={SUMMARY} status="failed" />, {
        columns: 110,
      }),
    )
    const crashed = stripAnsi(
      renderToString(<EndOfRunSummary run={RUN} summary={SUMMARY} status="crashed" />, {
        columns: 110,
      }),
    )

    expect(failed).toContain('failed')
    expect(crashed).toContain('crashed')
  })
})

describe('EndOfRunFooter copy', () => {
  it('leads with "q to quit · ⏎ to inspect" and includes the run status', () => {
    const frame = stripAnsi(renderToString(<EndOfRunFooter status="completed" />, { columns: 110 }))

    expect(frame).toContain('q to quit · ⏎ to inspect')
    expect(frame).toContain('run completed')
  })
})

describe('<StepsView> in a terminal state', () => {
  it('keeps Enter wired so resume on a past interactive step still fires onIntent', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={ENDED_STATE} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    // Selection auto-tracks the most-recent (live or last) step. ENDED_STATE
    // ends with `brainstorm` (interactive), so Enter targets it.
    ui.stdin.write('\r')
    await tick()

    expect(intents).toHaveLength(1)
    const intent = intents[0]
    expect(intent?.type).toBe('enter')
    if (intent?.type === 'enter') {
      expect(intent.stepName).toBe('brainstorm')
    }

    ui.unmount()
  })

  it('renders the same frame on a re-render with an unchanged terminal state (no flicker)', () => {
    const a = stripAnsi(
      renderToString(<StepsView state={ENDED_STATE} onIntent={() => {}} now={() => 5_000} />, {
        columns: 110,
      }),
    )
    const b = stripAnsi(
      renderToString(<StepsView state={ENDED_STATE} onIntent={() => {}} now={() => 5_000} />, {
        columns: 110,
      }),
    )

    expect(a).toEqual(b)
    // Both must contain the end-of-run footer copy, not the live keymap.
    expect(a).toContain('q to quit · ⏎ to inspect')
    expect(a).not.toContain('↑/↓ ⏎ f ? q')
  })
})
