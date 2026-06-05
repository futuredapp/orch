// Synthetic steps-view state for the S2 single-pane fixture.
//
// Builds a `StepsViewState` from a plain `{ steps, stopAt }` spec — the same
// live-mode shape the `model` driver synthesizes, but consumed by the real Ink
// `StepsView` rendered onto a real tmux pane (the `screen` driver, parent §3.3 /
// D4). Kept in `_support/` because both the fixture entry (a subprocess) and any
// future single-pane test build from it.

import type {
  RunHeader,
  StepRow,
  StepsViewState,
} from '../../../src/hosts/two-pane/steps-view/index.ts'

export interface SinglePaneStepsSpec {
  readonly steps: readonly string[]
  /** `'mid-step'` leaves the last step running; otherwise all complete. */
  readonly stopAt?: 'mid-step'
}

const RUN: RunHeader = {
  runId: 'r-2026-06-05-000000-screen',
  workflowName: 'demo',
  startedAt: 0,
}

export function buildLiveStepsViewState(spec: SinglePaneStepsSpec): StepsViewState {
  const last = spec.steps.length - 1
  const steps: StepRow[] = spec.steps.map((name, i) => {
    const running = spec.stopAt === 'mid-step' && i === last
    return running
      ? { kind: 'agent', mode: 'autonomous', status: 'running', name, startedAt: i * 1_000 }
      : {
          kind: 'agent',
          mode: 'autonomous',
          status: 'completed',
          name,
          startedAt: i * 1_000,
          endedAt: i * 1_000 + 500,
        }
  })
  return { status: 'live', run: RUN, steps, view: { mode: 'live' } }
}
