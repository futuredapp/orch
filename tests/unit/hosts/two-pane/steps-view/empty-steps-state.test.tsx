// triage: keep — Tier 2 empty-steps rendering.
//
// Before any step:start lands, the steps view should render an empty-state
// row rather than a blank list. Pins the placeholder copy and the footer.

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import type {
  StepsViewIntent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

function emptyState(): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [],
    view: { mode: 'live' },
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

describe('<StepsView> empty-steps state', () => {
  it('renders the placeholder row, the run header, and the live footer when steps is []', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={emptyState()} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).toContain('(no steps yet)')
    expect(frame).toContain('demo')
    expect(frame).toContain('▶ live')
  })

  it('Enter fires no intent when there is no selectable step', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={emptyState()} onIntent={(i) => intents.push(i)} now={() => NOW} />,
    )
    await tick()

    ui.stdin.write('\r')
    await tick()

    expect(intents).toEqual([])
    ui.unmount()
  })
})
