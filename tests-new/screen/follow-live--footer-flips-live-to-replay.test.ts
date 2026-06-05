import { scenario } from '../dsl/index.ts'

// Migration (parent U4.4, K2/K3). The `screen` byte twin that proves the
// live↔replay footer FLIP over REAL navigation: entering a past step shows the
// replay footer (`f live` hint) and following live returns the live footer
// (no `f live`). This re-derives the third `view-mode-footer.test.tsx` case and
// is the contract twin that the navigation protocol (U4.2) makes possible.
// Shares the `follow-live-view-mode` overlap group.

scenario(
  {
    name: 'the footer flips to the replay hint on enter and back to live on follow-live',
    feature: 'follow-live',
    drivers: ['screen'],
    risk: 'view-mode-footer-bytes',
    overlapGroup: 'follow-live-view-mode',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx',
    ],
  },
  async (app) => {
    // given — a run paused mid-step, live (no replay footer yet)
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })
    await app.leftPane.assertFollowLiveHintHidden()

    // when — the user enters (replays) the past step, the replay footer appears
    await app.leftPane.selectStep('plan')
    await app.leftPane.assertFollowLiveHintVisible()

    // then — following live returns the footer to live mode (replay hint gone)
    await app.leftPane.followLive()
    await app.leftPane.assertFollowLiveHintHidden()
  },
)
