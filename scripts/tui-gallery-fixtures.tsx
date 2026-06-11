// ---------------------------------------------------------------------------
// tui-gallery-fixtures — DEV-ONLY. The curated state catalog the gallery
// renders for human review. Pure data + element factories; the engine lives
// in `tui-gallery.tsx`.
// ---------------------------------------------------------------------------
//
// Each fixture is one named TUI state, optionally with a scripted interaction
// (keystrokes against the model harness) so dynamic states — scrolled lists,
// the open help overlay, a browsing preview cursor — get frames too.

import type { ReactElement } from 'react'
import { createElement } from 'react'
import { AskApp } from '../src/services/prompt/ink-app.tsx'
import type { PromptSpec } from '../src/services/prompt/prompt-service.ts'
import type {
  Banner,
  StepRow,
  StepStatus,
  StepsViewState,
} from '../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../src/hosts/two-pane/steps-view/index.ts'

/** Deterministic "now" — fixtures pin elapsed times against it. */
export const GALLERY_NOW = 120_000

export interface GalleryFixture {
  readonly name: string
  readonly title: string
  /** Pane widths to render at. Defaults to the engine's standard set. */
  readonly widths?: readonly number[]
  readonly rows?: number
  readonly element: () => ReactElement
  /**
   * Keystrokes sent after the first frame, with a needle that must appear
   * (or disappear) before capture so the interaction has settled.
   */
  readonly keys?: readonly string[]
  readonly settled?: (strippedFrame: string) => boolean
}

// ---------------------------------------------------------------------------
// StepsViewState builders
// ---------------------------------------------------------------------------

function agentStep(name: string, status: StepStatus, index: number, depth?: number): StepRow {
  const startedAt = index * 5_000
  const base = { kind: 'agent' as const, mode: 'autonomous' as const, status, name }
  const withDepth = depth !== undefined ? { ...base, depth } : base
  if (status === 'pending') return withDepth
  if (status === 'running' || status === 'interactive') return { ...withDepth, startedAt }
  return { ...withDepth, startedAt, endedAt: startedAt + 4_200 }
}

function liveState(steps: readonly StepRow[], banner?: Banner): StepsViewState {
  const base = {
    run: { runId: 'r-2026-06-11-091402-k3', workflowName: 'simple-feature', startedAt: 0 },
    steps,
    view: { mode: 'live' } as const,
  }
  return banner !== undefined ? { status: 'live', ...base, banner } : { status: 'live', ...base }
}

function terminalState(
  steps: readonly StepRow[],
  status: 'completed' | 'failed' | 'crashed',
): StepsViewState {
  const failed = steps.filter((s) => 'status' in s && s.status === 'failed').length
  return {
    status,
    run: { runId: 'r-2026-06-11-091402-k3', workflowName: 'simple-feature', startedAt: 0 },
    steps,
    view: { mode: 'live' },
    summary: {
      endedAt: GALLERY_NOW,
      durationMs: GALLERY_NOW,
      stepsTotal: steps.length,
      stepsCompleted: steps.length - failed,
      stepsFailed: failed,
    },
  }
}

function pipeline(names: readonly string[], runningIndex: number): StepRow[] {
  return names.map((name, i) =>
    agentStep(name, i < runningIndex ? 'completed' : i === runningIndex ? 'running' : 'pending', i),
  )
}

function manySteps(count: number): StepRow[] {
  return pipeline(
    Array.from({ length: count }, (_, i) => `step-${String(i + 1).padStart(2, '0')}`),
    count - 1,
  )
}

const noopIntent = (): void => {}
const frozenDismiss = (): (() => void) => () => {}

function steps(state: StepsViewState, actionsEnabled = false): ReactElement {
  return createElement(StepsView, {
    state,
    onIntent: noopIntent,
    now: () => GALLERY_NOW,
    scheduleDismiss: frozenDismiss,
    actionsEnabled,
  })
}

// ---------------------------------------------------------------------------
// Ask form builders
// ---------------------------------------------------------------------------

function askSpec(fields: readonly string[], buttons: readonly string[]): PromptSpec {
  return {
    question: 'Which approach should we take?',
    fields: fields.map((name) => ({ name, placeholder: `${name}…` })),
    buttons: [...buttons],
  }
}

function ask(spec: PromptSpec): ReactElement {
  return createElement(AskApp, { spec, onResolve: noopIntent })
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const SUB_STEPS: StepRow[] = [
  agentStep('plan', 'completed', 0),
  { kind: 'subworkflow-enter', name: 'deep-dive', depth: 1, subPath: ['deep-dive'], glyph: '▼' },
  agentStep('deep-dive>investigate', 'completed', 1, 1),
  agentStep('deep-dive>summarize', 'running', 2, 1),
  {
    kind: 'subworkflow-exit',
    name: 'review',
    depth: 1,
    subPath: ['review'],
    glyph: '✓',
    durationMs: 12_000,
  },
  agentStep('ship', 'pending', 3),
]

const ALL_STATUSES: StepRow[] = [
  agentStep('pending-step', 'pending', 0),
  agentStep('running-step', 'running', 1),
  agentStep('interactive-step', 'interactive', 2),
  agentStep('completed-step', 'completed', 3),
  agentStep('failed-step', 'failed', 4),
  agentStep('cached-step', 'cached', 5),
]

export const FIXTURES: readonly GalleryFixture[] = [
  {
    name: 'live-short',
    title: 'Live run, four steps, second one running',
    element: () => steps(liveState(pipeline(['plan', 'implement', 'review', 'ship'], 1))),
  },
  {
    name: 'live-info-banner',
    title: 'Live run with an info banner',
    element: () =>
      steps(
        liveState(pipeline(['plan', 'implement', 'review'], 1), {
          kind: 'info',
          text: 'step implement running — press f to follow',
          seq: 1,
        }),
      ),
  },
  {
    name: 'live-error-banner',
    title: 'Live run with a persistent error banner',
    element: () =>
      steps(
        liveState(pipeline(['plan', 'implement', 'review'], 1), {
          kind: 'error',
          text: 'right pane: failed to register replay source',
          seq: 1,
        }),
      ),
  },
  {
    name: 'live-40-steps-tail',
    title: '40 steps, pinned to the live tail',
    element: () => steps(liveState(manySteps(40))),
  },
  {
    name: 'live-40-steps-scrolled',
    title: '40 steps, scrolled 6 rows up from the tail',
    element: () => steps(liveState(manySteps(40))),
    keys: ['k', 'k', 'k', 'k', 'k', 'k'],
    settled: (frame) => frame.includes('scrolled'),
  },
  {
    name: 'live-40-steps-top',
    title: '40 steps, jumped to the top (g)',
    element: () => steps(liveState(manySteps(40))),
    keys: ['g'],
    settled: (frame) => frame.includes('step-01'),
  },
  {
    name: 'preview-cursor',
    title: 'Preview cursor browsing two rows above the committed selection',
    element: () => steps(liveState(pipeline(['plan', 'implement', 'review', 'ship'], 3))),
    keys: ['\u001B[A', '\u001B[A'],
    settled: (frame) => frame.includes('›'),
  },
  {
    name: 'subworkflow-rows',
    title: 'Subworkflow enter/exit boundary rows with a nested running step',
    element: () => steps(liveState(SUB_STEPS)),
  },
  {
    name: 'all-statuses',
    title: 'One row per step status (pending/running/interactive/completed/failed/cached)',
    element: () => steps(liveState(ALL_STATUSES)),
  },
  {
    name: 'help-overlay',
    title: 'Help overlay open',
    element: () => steps(liveState(pipeline(['plan', 'implement', 'review'], 1))),
    keys: ['?'],
    settled: (frame) => frame.includes('Keymap'),
  },
  {
    name: 'completed-summary',
    title: 'End-of-run summary, completed',
    element: () =>
      steps(terminalState(pipeline(['plan', 'implement', 'review', 'ship'], 99), 'completed')),
  },
  {
    name: 'failed-with-actions',
    title: 'Failed run, interactive re-entry with retry actions',
    element: () => {
      const rows = pipeline(['plan', 'implement', 'review'], 2)
      const failedRows = rows.map((r, i) => (i === 2 ? { ...r, status: 'failed' as const } : r))
      return steps(terminalState(failedRows, 'failed'), true)
    },
  },
  {
    name: 'narrow-deep-gutter',
    title: 'Depth-4 nesting at a narrow width (gutter collapse)',
    widths: [50],
    element: () =>
      steps(
        liveState([
          agentStep('root', 'completed', 0),
          agentStep('a>b>c>d>deep-step-name', 'running', 1, 4),
          agentStep('tail', 'pending', 2),
        ]),
      ),
  },
  {
    name: 'ask-two-fields',
    title: 'Ask form: two fields + three buttons',
    element: () => ask(askSpec(['reason', 'notes'], ['approve', 'reject', 'defer'])),
  },
  {
    name: 'ask-buttons-only',
    title: 'Ask form: no fields, buttons only',
    element: () => ask(askSpec([], ['ship it', 'hold'])),
  },
  {
    name: 'ask-filled-field',
    title: 'Ask form: first field with typed text',
    element: () => ask(askSpec(['reason'], ['approve', 'reject'])),
    keys: ['because the tests pass'],
    settled: (frame) => frame.includes('because the tests pass'),
  },
]
