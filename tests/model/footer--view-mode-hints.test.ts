import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `model` half of the VIEW-MODE FOOTER hints: live
// mode leads with the view-step + help hints; entering a past step flips the
// footer to `⏸ viewing <step> · f live`. The published footer copy is the user's
// only durable signal of which mode the right pane is in. Byte twin shares
// `view-mode-footer-hints`.

scenario(
  {
    name: 'the footer shows live hints, then flips to the viewing+follow hints in replay',
    feature: 'view-mode-footer',
    drivers: ['model'],
    risk: 'footer-mode-indicator',
    overlapGroup: 'view-mode-footer-hints',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx'],
  },
  async (app) => {
    // given — a paused live run
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // then — live mode leads with the view-step + help hints
    await app.leftPane.assertViewStepHintVisible()
    await app.leftPane.assertHelpHintVisible()
    await app.leftPane.assertFollowLiveHintHidden()

    // when — entering a past step
    await app.leftPane.selectStep('plan')

    // then — the footer flips to the replay hints
    await app.leftPane.assertViewingHintVisible('plan')
    await app.leftPane.assertFollowLiveHintVisible()
  },
)
