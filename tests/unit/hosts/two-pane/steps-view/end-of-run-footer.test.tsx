// triage: keep — Tier 2 end-of-run footer rendering.
//
// Every terminal status (`completed`, `failed`, `crashed`) replaces the live
// footer with the published end-of-run copy (`q to quit · ⏎ to inspect`)
// alongside the workflow's terminal-state colored marker. Pre-terminal
// states (`status: 'live'`) keep the live footer.

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import type { StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

function terminal(status: 'completed' | 'failed' | 'crashed'): StepsViewState {
  return {
    status,
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: status === 'completed' ? 'completed' : 'failed',
        name: 'plan',
        startedAt: 0,
        endedAt: 1_000,
      },
    ],
    summary: {
      endedAt: 1_000,
      durationMs: 1_000,
      stepsTotal: 1,
      stepsCompleted: status === 'completed' ? 1 : 0,
      stepsFailed: status === 'completed' ? 0 : 1,
    },
    view: { mode: 'live' },
  }
}

describe('<StepsView> end-of-run footer', () => {
  it('completed terminal status shows the run-completed footer', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={terminal('completed')} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('run completed')
    expect(frame).toContain('q to quit')
    expect(frame).toContain('inspect')
    expect(frame).not.toContain('▶ live · ⏎ view step')
  })

  it('failed terminal status shows the run-failed footer', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={terminal('failed')} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('run failed')
    expect(frame).toContain('q to quit')
  })

  it('crashed terminal status shows the run-crashed footer', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={terminal('crashed')} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('run crashed')
    expect(frame).toContain('q to quit')
  })

  it('pre-terminal (status: live) keeps the live footer indicator', () => {
    const live: StepsViewState = {
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
    const frame = stripAnsi(
      renderToString(<StepsView state={live} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('▶ live')
    expect(frame).not.toContain('run completed')
  })
})
