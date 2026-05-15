// triage: keep — Tier 2 projection coverage for the view-mode footer.
//
// The published footer copy is the user's only durable signal of which mode
// the right pane is in. `▶ live · ⏎ view step · q quit · ? help` for live;
// `⏸ viewing <step> · f live · ⏎ view another · q quit · ? help` for replay.
// A regression here ships as "I cannot tell which mode I'm in".

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import type { StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

function liveState(): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'running',
        name: 'plan',
        startedAt: 1_000,
      },
    ],
    view: { mode: 'live' },
  }
}

function replayState(stepName: string): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'completed',
        name: stepName,
        startedAt: 0,
        endedAt: 1_000,
      },
    ],
    view: { mode: 'replay', stepName },
  }
}

describe('<StepsView> view-mode footer at width 110', () => {
  it("live mode renders '▶ live · ⏎ view step · q quit · ? help'", () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={liveState()} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('▶ live')
    expect(frame).toContain('⏎ view step')
    expect(frame).toContain('q quit')
    expect(frame).not.toContain('⏸ viewing')
  })

  it("replay mode renders '⏸ viewing <stepName> · f live · ⏎ view another'", () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={replayState('plan')} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('⏸ viewing plan')
    expect(frame).toContain('f live')
    expect(frame).toContain('⏎ view another')
    expect(frame).not.toContain('▶ live · ⏎ view step')
  })

  it('flipping state from live → replay re-renders the footer indicator', () => {
    const liveFrame = stripAnsi(
      renderToString(<StepsView state={liveState()} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    const replayFrame = stripAnsi(
      renderToString(<StepsView state={replayState('plan')} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(liveFrame).toContain('▶ live')
    expect(replayFrame).toContain('⏸ viewing plan')
    expect(liveFrame).not.toEqual(replayFrame)
  })
})
