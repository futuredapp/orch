import { scenario } from '../dsl/index.ts'

// Migration (parent U6a.2). The `model` half of the keymap HELP OVERLAY: `?`
// opens the overlay (the controller chooses to show it), `Esc` closes it, and
// the step list survives the toggle. This closes the U5b-deferred "Esc/help
// keymap mechanics" (`→U6` in the U5b ledger). The byte twin (`screen`) shares
// `overlapGroup: 'help-overlay'`, so the blocking overlap report requires both.

scenario(
  {
    name: 'pressing ? opens the keymap overlay and Esc closes it, leaving the step list intact',
    feature: 'help-overlay',
    drivers: ['model'],
    risk: 'help-overlay-decision',
    overlapGroup: 'help-overlay',
    oldTestRefs: [
      'tests/integration/lifecycle/nav.help-overlay-opens-and-closes.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a paused live run
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

    // then — the overlay is not shown until asked for
    await app.leftPane.assertHelpHidden()

    // when — the user opens help
    await app.leftPane.openHelp()

    // then — the controller shows the overlay
    await app.leftPane.assertHelpVisible()

    // when — the user closes it
    await app.leftPane.closeHelp()

    // then — the overlay is gone and the step list survived the toggle
    await app.leftPane.assertHelpHidden()
    await app.leftPane.assertStepListSurvives(['plan', 'execute', 'review'])
  },
)
