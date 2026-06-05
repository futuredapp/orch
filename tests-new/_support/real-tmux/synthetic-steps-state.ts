// Synthetic steps-view state for the S2 single-pane fixture.
//
// Builds a `StepsViewState` from a plain `{ steps, stopAt, banner }` spec — the
// same live-mode shape the `model` driver synthesizes, but consumed by the real
// Ink `StepsView` rendered onto a real tmux pane (the `screen` driver, parent
// §3.3 / D4). Kept in `_support/` because both the fixture entry (a subprocess)
// and any future single-pane test build from it.

import type {
  Banner,
  RunHeader,
  StepRow,
  StepsViewState,
} from '../../../src/hosts/two-pane/steps-view/index.ts'

// The barrel re-exports the `EndOfRunSummary` *component*, not the type, so the
// summary type is derived structurally from the terminal `StepsViewState` arm.
type EndOfRunSummary = Extract<StepsViewState, { status: 'completed' }>['summary']

export interface SinglePaneStepsSpec {
  readonly steps: readonly string[]
  /**
   * `'mid-step'` leaves the last step running; `'end-of-run'` reaches a terminal
   * state with an end-of-run summary (U5b). Omitted ⇔ all complete, still live.
   */
  readonly stopAt?: 'mid-step' | 'end-of-run'
  /** Terminal outcome for `stopAt: 'end-of-run'` (U5b — summary colours). */
  readonly outcome?: 'completed' | 'failed' | 'crashed'
  /** Optional banner rendered above the steps grid (U5b — banner paint twin). */
  readonly banner?: { readonly kind: 'info' | 'error'; readonly text: string }
}

const RUN: RunHeader = {
  runId: 'r-2026-06-05-000000-screen',
  workflowName: 'demo',
  startedAt: 0,
}

function buildSteps(spec: SinglePaneStepsSpec): StepRow[] {
  const last = spec.steps.length - 1
  const failLast =
    spec.stopAt === 'end-of-run' && spec.outcome !== undefined && spec.outcome !== 'completed'
  return spec.steps.map((name, i) => {
    if (spec.stopAt === 'mid-step' && i === last) {
      return { kind: 'agent', mode: 'autonomous', status: 'running', name, startedAt: i * 1_000 }
    }
    const status = failLast && i === last ? 'failed' : 'completed'
    return {
      kind: 'agent',
      mode: 'autonomous',
      status,
      name,
      startedAt: i * 1_000,
      endedAt: i * 1_000 + 500,
    }
  })
}

function summaryFor(steps: readonly StepRow[], failed: boolean): EndOfRunSummary {
  return {
    endedAt: steps.length * 1_000,
    durationMs: steps.length * 1_000,
    stepsTotal: steps.length,
    stepsCompleted: failed ? steps.length - 1 : steps.length,
    stepsFailed: failed ? 1 : 0,
  }
}

export function buildLiveStepsViewState(spec: SinglePaneStepsSpec): StepsViewState {
  const steps = buildSteps(spec)
  const banner: Banner | undefined =
    spec.banner !== undefined
      ? { kind: spec.banner.kind, text: spec.banner.text, seq: 1 }
      : undefined
  const base = { run: RUN, steps, view: { mode: 'live' } as const }
  if (spec.stopAt === 'end-of-run') {
    const failed = spec.outcome !== undefined && spec.outcome !== 'completed'
    const summary = summaryFor(steps, failed)
    const status = spec.outcome === 'crashed' ? 'crashed' : failed ? 'failed' : 'completed'
    return banner !== undefined
      ? { status, summary, ...base, banner }
      : { status, summary, ...base }
  }
  return banner !== undefined ? { status: 'live', ...base, banner } : { status: 'live', ...base }
}
