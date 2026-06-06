// ---------------------------------------------------------------------------
// single-pane-steps-entry — the Ink child the S2 `screen` fixture runs in ONE
// real tmux pane (parent D4). It renders the REAL `<StepsView>` component with a
// synthetic live state decoded from `--spec <base64-json>`, so the full
// Ink→tmux→capture byte path is exercised and a production wording/layout typo
// goes red (R5). No right-pane controller, no pane-map, no full host — just the
// steps pane.
//
// The entry is INTERACTIVE (parent U4, K2): it holds the right-pane `view` mode
// in React state and updates it from `<StepsView>`'s `onIntent` — mirroring the
// `model` driver's `ModelHarness`. That makes `selectStep` (Enter → replay) and
// `followLive` (`f` → live) commit a real selection change over real tmux, so
// the `screen` driver can prove the live↔replay footer flip via genuine
// navigation, not a synthetic view prop.
//
// The process stays alive until tmux kills the pane on fixture teardown.

import { render } from 'ink'
import { createElement, type ReactElement, useCallback, useState } from 'react'
import {
  StepsView,
  type StepsViewIntent,
  type StepsViewState,
  type ViewMode,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import { buildLiveStepsViewState, type SinglePaneStepsSpec } from './synthetic-steps-state.ts'

// Deterministic clock for `<StepRow>` elapsed math — keeps frames stable.
const NOW = 5_000
const LIVE_VIEW: ViewMode = { mode: 'live' }

function parseSpec(argv: readonly string[]): SinglePaneStepsSpec {
  const idx = argv.indexOf('--spec')
  const raw = idx === -1 ? undefined : argv[idx + 1]
  if (raw === undefined) throw new Error('single-pane-steps-entry: missing --spec <base64-json>')
  const json = Buffer.from(raw, 'base64').toString('utf8')
  return JSON.parse(json) as SinglePaneStepsSpec
}

interface SinglePaneStepsProps {
  readonly base: StepsViewState
}

// Holds `view` in state and updates it from the same intents a real keypress
// produces, so the genuine selection logic (committed-from-view, snap-to-live)
// runs against the real component + hooks under real tmux.
function SinglePaneSteps({ base }: SinglePaneStepsProps): ReactElement {
  const [view, setView] = useState<ViewMode>(LIVE_VIEW)
  const onIntent = useCallback((intent: StepsViewIntent): void => {
    if (intent.type === 'enter') {
      setView({ mode: 'replay', stepName: intent.stepName })
    } else if (intent.type === 'follow-live') {
      setView(LIVE_VIEW)
    }
    // 'quit' / 'dismiss-banner' have no projection effect in the screen substrate.
  }, [])

  const state: StepsViewState = { ...base, view }
  return createElement(StepsView, { state, onIntent, now: () => NOW })
}

const spec = parseSpec(process.argv)
const base = buildLiveStepsViewState(spec)

render(createElement(SinglePaneSteps, { base }))

// Pin the process alive — Ink keeps the loop running, but an explicit timer
// guarantees the pane keeps rendering until tmux kills it at teardown.
setInterval(() => {}, 1 << 30)
