// COVERED BY → tests-new/model/selection--auto-tracks-live-and-browses.test.ts (parent U14 group-B closeout) — every case covered; see ledger. Kept skipped on disk (D2).
// triage: keep — Tier 2 projection coverage for the HARD invariant that the
// LEFT pane's highlighted row always equals the step the RIGHT pane shows
// (`state.view`). Issue 2: the left highlight drifts out of sync with the
// right pane.
//
// Why this satisfies the triage rule ("would this pass if the visible pane
// were empty/wrong/unformatted?"): the assertions parse the rendered frame for
// the WHICH-row-carries-the-`▌`-cursor signal and compare it to `state.view`.
// An empty, unhighlighted, or mis-highlighted left pane fails — that is exactly
// the regression.
//
// REPRODUCING / target-contract test: it FAILS on current code and PASSES once
// the bug is fixed. See the per-case comments for the precise reason each fails
// and the API gap the fixer must close.

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type { StepRow, StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

// The selected row is marked with the `▌` cursor glyph at the start of its line
// (see <StepRow>: `const cursor = selected ? '▌' : ' '`). Cyan/bold are ANSI
// styling that `stripAnsi` removes, so the cursor glyph is the only selection
// signal that survives into a stripped frame — and the one a user sees.
const CURSOR = '▌'

// Tick budget mirrors selection.test.tsx — Ink's reconciler needs ~30ms to
// settle effects (useStepsSelection seeds selection inside a useEffect).
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * Returns the step name whose rendered row carries the selection cursor, or
 * `undefined` when no row is highlighted. Parses the stripped frame line-by-
 * line: a selected row's line is `▌ <name>  <glyph> …`; an unselected row's
 * line begins with a leading space instead of the cursor.
 */
function highlightedStepName(frame: string, candidateNames: readonly string[]): string | undefined {
  for (const line of frame.split('\n')) {
    if (!line.includes(CURSOR)) continue
    const afterCursor = line.slice(line.indexOf(CURSOR) + CURSOR.length)
    const match = candidateNames.find((name) => afterCursor.includes(name))
    if (match !== undefined) return match
  }
  return undefined
}

function baseRun(): StepsViewState['run'] {
  return { runId: 'r-2026-05-25-100000-aa', workflowName: 'demo', startedAt: 0 }
}

const STEP_PLAN: StepRow = {
  kind: 'agent',
  mode: 'autonomous',
  status: 'completed',
  name: 'plan',
  startedAt: 0,
  endedAt: 1_000,
}

const STEP_WORK: StepRow = {
  kind: 'agent',
  mode: 'autonomous',
  status: 'running',
  name: 'work',
  startedAt: 2_000,
}

// A live state whose right pane is showing `stepName` in replay mode — the left
// pane MUST highlight that same row.
function replayState(steps: readonly StepRow[], stepName: string): StepsViewState {
  return { status: 'live', run: baseRun(), steps, view: { mode: 'replay', stepName } }
}

describe.skip('<StepsView> left-pane selection tracks the right-pane view (Issue 2)', () => {
  it('highlights the single live step at startup so the left pane matches the right pane', async () => {
    const steps: readonly StepRow[] = [STEP_WORK]
    const state = replayState(steps, 'work')

    const ui = render(<StepsView state={state} onIntent={NOOP} now={() => NOW} />)
    await tick()

    // FAILS today: at startup `useStepsSelection` leaves `isUserDriven=false`,
    // and the row is only marked `selected` when `isUserDriven` is true
    // (steps-view.tsx L256 `selected={step.name === selectedName && isUserDriven}`).
    // So no `▌` cursor is rendered even though the right pane shows `work`.
    expect(highlightedStepName(stripAnsi(ui.lastFrame() ?? ''), ['work'])).toBe('work')

    ui.unmount()
  })

  it('keeps the highlight on the step the right pane shows when there are multiple steps at startup', async () => {
    const steps: readonly StepRow[] = [STEP_PLAN, STEP_WORK]
    const state = replayState(steps, 'work')

    const ui = render(<StepsView state={state} onIntent={NOOP} now={() => NOW} />)
    await tick()

    // FAILS today for the same `&& isUserDriven` reason: nothing is highlighted
    // at startup, so the parsed cursor name is `undefined`, not `'work'`.
    expect(highlightedStepName(stripAnsi(ui.lastFrame() ?? ''), ['plan', 'work'])).toBe('work')

    ui.unmount()
  })

  it('moves the highlight to the next step when the right pane auto-advances without a keypress', async () => {
    const steps: readonly StepRow[] = [STEP_PLAN, STEP_WORK]

    // Right pane is replaying `plan`; left highlight must be on `plan`.
    const ui = render(
      <StepsView state={replayState(steps, 'plan')} onIntent={NOOP} now={() => NOW} />,
    )
    await tick()

    // Live auto-advances the right pane to `work` — NO user keypress.
    ui.rerender(<StepsView state={replayState(steps, 'work')} onIntent={NOOP} now={() => NOW} />)
    await tick()

    // FAILS today: `useStepsSelection` derives selection from `state.steps`
    // only and is never told about `state.view`, so it cannot follow the right
    // pane's auto-advance. The highlight stays frozen (or, given the
    // `&& isUserDriven` gate, is absent entirely). It must move to `work`.
    expect(highlightedStepName(stripAnsi(ui.lastFrame() ?? ''), ['plan', 'work'])).toBe('work')

    ui.unmount()
  })

  it('shows exactly one highlighted row and it equals the right-pane step', async () => {
    const steps: readonly StepRow[] = [STEP_PLAN, STEP_WORK]
    const state = replayState(steps, 'plan')

    const ui = render(<StepsView state={state} onIntent={NOOP} now={() => NOW} />)
    await tick()

    const frame = stripAnsi(ui.lastFrame() ?? '')
    const cursorLines = frame.split('\n').filter((line) => line.includes(CURSOR))

    // Exactly one row carries the cursor (no double-highlight, no empty), and
    // it is the step the right pane is showing. FAILS today: zero cursor lines.
    expect(cursorLines).toHaveLength(1)
    expect(highlightedStepName(frame, ['plan', 'work'])).toBe('plan')

    ui.unmount()
  })
})
