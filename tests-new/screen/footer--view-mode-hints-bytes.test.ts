import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `screen` byte twin of the view-mode footer hints:
// the live hints and the `⏸ viewing <step> · f live` replay footer must survive
// real tmux, driven by a genuine selection change. Shares `view-mode-footer-hints`.

scenario(
  {
    name: 'the footer hints render as real tmux bytes and flip on a genuine selection change',
    feature: 'view-mode-footer',
    drivers: ['screen'],
    risk: 'footer-mode-bytes',
    overlapGroup: 'view-mode-footer-hints',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx'],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    await app.leftPane.assertViewStepHintVisible()
    await app.leftPane.assertHelpHintVisible()
    await app.leftPane.assertFollowLiveHintHidden()

    await app.leftPane.selectStep('plan')

    await app.leftPane.assertViewingHintVisible('plan')
    await app.leftPane.assertFollowLiveHintVisible()
  },
)
