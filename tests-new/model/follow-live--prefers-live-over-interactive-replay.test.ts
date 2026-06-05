import { scenario } from '../dsl/index.ts'

// Migration (parent U4.3). The model-level intent the old mocked integration
// test asserted: after the user enters (replays) a past step, pressing
// follow-live re-selects the LIVE step — live wins over the interactive replay.
// Pure controller decision, no tmux; no `screen` twin needed (the follow-live
// byte path is covered by `follow-live--footer-flips-live-to-replay [screen]`).

scenario(
  {
    name: 'follow-live re-selects the live step after the user entered a past step',
    feature: 'follow-live',
    drivers: ['model'],
    risk: 'live-over-replay',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/follow-live-prefers-live-over-interactive-replay.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a run paused with an earlier step done and the last step live
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // when — the user replays the past step, then asks to follow the live source
    await app.leftPane.selectStep('plan')
    await app.leftPane.followLive()

    // then — the controller prefers the live step over the interactive replay
    await app.leftPane.assertStepSelected('execute')
  },
)
