import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `model` half of the END-OF-RUN summary: a terminal
// run repaints the header into a totals/duration block, shows the completion
// count, and the footer leads with `run completed · q to quit · ⏎ to inspect`.
// Byte twin shares `end-of-run-summary`.

scenario(
  {
    name: 'a completed run shows the summary totals, completion count, and terminal footer',
    feature: 'end-of-run',
    drivers: ['model'],
    risk: 'end-of-run-summary',
    overlapGroup: 'end-of-run-summary',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx',
      'tests/unit/hosts/two-pane/steps-view/end-of-run-footer.test.tsx',
      'tests/integration/lifecycle/end-of-run.summary-and-completion-count-visible.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a fully completed run
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'end-of-run' })

    // then — totals + duration, the completion count, and the terminal footer
    await app.leftPane.assertEndOfRunSummaryShows('duration')
    await app.leftPane.assertCompletionCount(3, 3)
    await app.leftPane.assertTerminalFooterVisible('completed')

    // and — Enter is still wired in the terminal state (resume on a past step)
    await app.leftPane.selectStep('plan')
    await app.leftPane.assertStepSelected('plan')
  },
)
