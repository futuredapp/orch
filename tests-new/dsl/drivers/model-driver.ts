// ---------------------------------------------------------------------------
// model driver — controller decisions / projection seam, NO tmux (the bulk).
// ---------------------------------------------------------------------------
//
// Builds a `ModelApp` over the steps-view Ink-render projection seam (today's
// Tier-2 approach): render `<StepsView>` via `ink-testing-library`, drive its
// input, and poll `lastFrame()` (stripped of ANSI). Assertions inspect the
// PROJECTED/RENDERED view-model — what the controller DECIDED to show — never a
// fake tmux. It allocates no socket and boots no tmux (R5).
//
// A tiny harness holds the right-pane `view` mode in React state and updates it
// from the same `StepsViewIntent`s a real keypress produces, so the genuine
// logic under test (selection tracking `view`, snap-to-live picking the live
// step) runs against the real component + hooks.

import { createElement, type ReactElement, useCallback, useEffect, useState } from 'react'
import { render } from 'ink-testing-library'
import { stepGlyphView, stripAnsi } from '../../../src/observability/index.ts'
import type {
  RunHeader,
  StepRow,
  StepStatus,
  StepsViewIntent,
  StepsViewState,
  ViewMode,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../src/hosts/two-pane/steps-view/index.ts'
import { pressUntilFrame, waitForFrame } from '@orch/test/ink-frame.ts'
import type { DriverName, ModelApp, ModelSpec } from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import type { GlyphName, PaneDriver } from '../panes/pane-driver.ts'
import type { ScenarioMeta } from '../scenario.ts'
import type { Driver } from './registry.ts'

// Deterministic clock for `<StepRow>` elapsed math — keeps frames stable.
const NOW = 5_000
const MODEL_TIMEOUT_MS = 10_000

// The committed (right-pane-tracking) row renders this cursor glyph. Cyan/bold
// are ANSI styling stripped from the frame, so the cursor is the only selection
// signal that survives — and the one the user sees.
const CURSOR = '▌'

const LIVE_VIEW: ViewMode = { mode: 'live' }

const GLYPH_STATUS: Record<GlyphName, StepStatus> = {
  running: 'running',
  done: 'completed',
  failed: 'failed',
}

type Instance = ReturnType<typeof render>

interface HarnessApi {
  dispatch(intent: StepsViewIntent): void
}

interface LiveBase {
  readonly status: 'live'
  readonly run: RunHeader
  readonly steps: readonly StepRow[]
}

interface ModelHarnessProps {
  readonly base: LiveBase
  readonly now: number
  readonly onApi: (api: HarnessApi) => void
}

function ModelHarness({ base, now, onApi }: ModelHarnessProps): ReactElement {
  const [view, setView] = useState<ViewMode>(LIVE_VIEW)
  const dispatch = useCallback((intent: StepsViewIntent): void => {
    if (intent.type === 'enter') {
      setView({ mode: 'replay', stepName: intent.stepName })
    } else if (intent.type === 'follow-live') {
      setView(LIVE_VIEW)
    }
    // 'quit' / 'dismiss-banner' have no projection effect in the model substrate.
  }, [])

  useEffect(() => {
    onApi({ dispatch })
  }, [onApi, dispatch])

  const state: StepsViewState = { ...base, view }
  return createElement(StepsView, { state, onIntent: dispatch, now: () => now })
}

function buildLiveBase(spec: ModelSpec): LiveBase {
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
  return {
    status: 'live',
    run: { runId: 'r-2026-06-05-000000-u1', workflowName: 'demo', startedAt: 0 },
    steps,
  }
}

// The step `follow-live` snaps to: the running step under `stopAt: 'mid-step'`,
// otherwise the last step (matching `committedFromView` in live mode).
function computeLiveName(spec: ModelSpec): string | undefined {
  return spec.steps[spec.steps.length - 1]
}

// --- frame parsing helpers --------------------------------------------------

function highlightedStepName(frame: string, names: readonly string[]): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.includes(CURSOR)) continue
    const afterCursor = line.slice(line.indexOf(CURSOR) + CURSOR.length)
    const match = names.find((name) => afterCursor.includes(name))
    if (match !== undefined) return match
  }
  return undefined
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function rowHasGlyph(frame: string, step: string, glyph: string): boolean {
  return frame.split('\n').some((line) => line.includes(step) && line.includes(glyph))
}

// --- the app ----------------------------------------------------------------

function createModelApp(): ModelApp {
  let ui: Instance | undefined
  let api: HarnessApi | undefined
  let stepNames: readonly string[] = []
  let liveName: string | undefined

  const requireUi = (): Instance => {
    if (ui === undefined) {
      throw new Error('model driver: launch(spec) must be called before any assertion')
    }
    return ui
  }

  const paneDriver: PaneDriver = {
    async assertBottomText(literal, { count }): Promise<void> {
      await waitForFrame(requireUi(), (f) => occurrences(f, literal) === count, {
        transform: stripAnsi,
      })
    },
    async assertContains(text): Promise<void> {
      await waitForFrame(requireUi(), (f) => f.includes(text), { transform: stripAnsi })
    },
    async assertSelected(step): Promise<void> {
      await waitForFrame(requireUi(), (f) => highlightedStepName(f, stepNames) === step, {
        transform: stripAnsi,
      })
    },
    async assertGlyph(step, glyph): Promise<void> {
      const wanted = stepGlyphView(GLYPH_STATUS[glyph]).char
      await waitForFrame(requireUi(), (f) => rowHasGlyph(f, step, wanted), { transform: stripAnsi })
    },
    async selectStep(step): Promise<void> {
      const instance = requireUi()
      if (api === undefined) throw new Error('model driver: harness api not ready')
      api.dispatch({ type: 'enter', stepName: step })
      await waitForFrame(instance, (f) => highlightedStepName(f, stepNames) === step, {
        transform: stripAnsi,
      })
    },
    async followLive(): Promise<void> {
      const instance = requireUi()
      const target = liveName
      if (target === undefined) throw new Error('model driver: spec has no live step to follow')
      // `f` (snap-to-live) is idempotent w.r.t. the asserted committed step, so
      // resending until it lands defeats the useInput-subscribe race safely.
      await pressUntilFrame(instance, 'f', (f) => highlightedStepName(f, stepNames) === target, {
        transform: stripAnsi,
      })
    },
  }

  const leftPane = new LeftPane(paneDriver)

  return {
    async launch(spec): Promise<void> {
      stepNames = spec.steps
      liveName = computeLiveName(spec)
      const base = buildLiveBase(spec)
      const instance = render(
        createElement(ModelHarness, {
          base,
          now: NOW,
          onApi: (a) => {
            api = a
          },
        }),
      )
      ui = instance
      await waitForFrame(instance, (f) => f.length > 0)
    },
    leftPane,
    async teardown(): Promise<void> {
      ui?.unmount()
      ui = undefined
      api = undefined
      stepNames = []
      liveName = undefined
    },
  }
}

export const modelDriver: Driver<ModelApp> = {
  build: (_meta: ScenarioMeta<readonly DriverName[]>): Promise<ModelApp> =>
    Promise.resolve(createModelApp()),
  skip: () => false,
  timeout: MODEL_TIMEOUT_MS,
}
