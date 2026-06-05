// Color assertions for `<EndOfRunSummary>` status label.
//
// Same chalk-level-3 force as `steps-view-colors.test.tsx` — Bun's non-TTY
// stdout causes chalk to default to level 0, which makes Ink emit no ANSI.

import chalk from 'chalk'

chalk.level = 3

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { EndOfRunSummary } from '../../../../../src/hosts/two-pane/steps-view/index.ts'

const GREEN_FG = '\x1b[32m'
const RED_FG = '\x1b[31m'

const RUN = {
  runId: 'r-2026-05-12-000000-aa',
  workflowName: 'demo',
  startedAt: 0,
}

const SUMMARY = {
  endedAt: 5_000,
  durationMs: 5_000,
  stepsTotal: 3,
  stepsCompleted: 2,
  stepsFailed: 1,
}

// MIGRATED → tests-new/model/end-of-run--summary-colors.test.ts
//          + tests-new/screen/end-of-run--summary-colors-bytes.test.ts  (parent U5b)
//   (the "does not color the header text" case is merged — see ledger reason.)
describe.skip('<EndOfRunSummary> status label color', () => {
  it('renders the "completed" label in green', () => {
    const frame = renderToString(
      <EndOfRunSummary run={RUN} summary={SUMMARY} status="completed" />,
      { columns: 110 },
    )
    expect(frame).toContain(GREEN_FG)
    expect(frame).toContain('completed')
    // The duration line (dimColor) shouldn't pick up green.
    const headerLine = frame.split('\n')[0] ?? ''
    expect(headerLine).toContain(GREEN_FG)
  })

  it('renders the "failed" label in red', () => {
    const frame = renderToString(<EndOfRunSummary run={RUN} summary={SUMMARY} status="failed" />, {
      columns: 110,
    })
    expect(frame).toContain(RED_FG)
    expect(frame).toContain('failed')
  })

  it('renders the "crashed" label in red', () => {
    const frame = renderToString(<EndOfRunSummary run={RUN} summary={SUMMARY} status="crashed" />, {
      columns: 110,
    })
    expect(frame).toContain(RED_FG)
    expect(frame).toContain('crashed')
  })

  it('does not color the run header text (only the status word)', () => {
    const frame = renderToString(
      <EndOfRunSummary run={RUN} summary={SUMMARY} status="completed" />,
      { columns: 110 },
    )
    // The "orch · demo · <runId> · " prefix should appear before the first green ANSI.
    const greenIdx = frame.indexOf(GREEN_FG)
    expect(greenIdx).toBeGreaterThan(0)
    const beforeGreen = frame.slice(0, greenIdx)
    expect(beforeGreen).toContain('orch')
    expect(beforeGreen).toContain('demo')
  })
})
