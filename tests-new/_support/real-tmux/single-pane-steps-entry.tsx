// ---------------------------------------------------------------------------
// single-pane-steps-entry — the Ink child the S2 `screen` fixture runs in ONE
// real tmux pane (parent D4). It renders the REAL `<StepsView>` component with a
// synthetic live state decoded from `--spec <base64-json>`, so the full
// Ink→tmux→capture byte path is exercised and a production wording/layout typo
// goes red (R5). No right-pane controller, no pane-map, no full host — just the
// steps pane.
//
// The process stays alive until tmux kills the pane on fixture teardown.

import { render } from 'ink'
import { createElement } from 'react'
import { StepsView } from '../../../src/hosts/two-pane/steps-view/index.ts'
import { buildLiveStepsViewState, type SinglePaneStepsSpec } from './synthetic-steps-state.ts'

// Deterministic clock for `<StepRow>` elapsed math — keeps frames stable.
const NOW = 5_000

function parseSpec(argv: readonly string[]): SinglePaneStepsSpec {
  const idx = argv.indexOf('--spec')
  const raw = idx === -1 ? undefined : argv[idx + 1]
  if (raw === undefined) throw new Error('single-pane-steps-entry: missing --spec <base64-json>')
  const json = Buffer.from(raw, 'base64').toString('utf8')
  return JSON.parse(json) as SinglePaneStepsSpec
}

const spec = parseSpec(process.argv)
const state = buildLiveStepsViewState(spec)

render(createElement(StepsView, { state, onIntent: () => {}, now: () => NOW }))

// Pin the process alive — Ink keeps the loop running, but an explicit timer
// guarantees the pane keeps rendering until tmux kills it at teardown.
setInterval(() => {}, 1 << 30)
