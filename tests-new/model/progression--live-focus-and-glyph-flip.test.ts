import { scenario } from '../dsl/index.ts'

// Migration (parent U6b.1). The progression decisions: as steps complete, the
// LIVE FOCUS follows the newly-running step (the committed selection auto-tracks
// it) and each completed step's GLYPH FLIPS to the done check. Both are pure
// controller decisions over the projected view-model — `model` only. The glyph
// COLOUR bytes already have a `screen` twin (U5 `glyph--state-and-color`), so no
// new overlapGroup is needed here.

scenario(
  {
    name: 'live focus follows the newest running step and completed steps flip to the done glyph',
    feature: 'progression',
    drivers: ['model'],
    risk: 'live-focus-and-glyph-progression',
    oldTestRefs: [
      'tests/integration/lifecycle/progression.live-focus-follows-newly-running-step.behavioral.real.test.ts',
      'tests/integration/lifecycle/progression.step-completes-glyph-flips-to-check.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a run where the first two steps have completed and the third is live
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

    // then — completed steps flipped to the done glyph
    await app.leftPane.assertGlyph('plan', 'done')
    await app.leftPane.assertGlyph('execute', 'done')

    // and — the newest running step holds the running glyph
    await app.leftPane.assertGlyph('review', 'running')

    // and — live focus follows it: the committed (right-pane-tracking) selection
    // auto-tracks the newly-running step
    await app.leftPane.assertStepSelected('review')
  },
)
