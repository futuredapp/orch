import { scenario } from '../dsl/index.ts'

// Migration (parent U6a.2). The `screen` byte twin of the keymap HELP OVERLAY:
// the overlay bytes must paint off real tmux when `?` is pressed and disappear
// on `Esc`, without corrupting the step rows. Shares `overlapGroup:
// 'help-overlay'` with the model decision twin.

scenario(
  {
    name: 'the help overlay paints as real tmux bytes on ? and clears on Esc without eating the step list',
    feature: 'help-overlay',
    drivers: ['screen'],
    risk: 'help-overlay-bytes',
    overlapGroup: 'help-overlay',
    oldTestRefs: [
      'tests/integration/lifecycle/nav.help-overlay-opens-and-closes.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

    await app.leftPane.assertHelpHidden()
    await app.leftPane.openHelp()
    await app.leftPane.assertHelpVisible()

    await app.leftPane.closeHelp()
    await app.leftPane.assertHelpHidden()
    await app.leftPane.assertStepListSurvives(['plan', 'execute', 'review'])
  },
)
