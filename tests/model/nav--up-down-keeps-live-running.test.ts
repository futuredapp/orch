import { scenario } from '../dsl/index.ts'

// Migration (parent U6a.3). `nav.up-down-moves-selection-without-detaching-live`:
// moving the ↑/↓ preview cursor is DECOUPLED from live focus — the running step
// keeps its `running` glyph and the committed selection stays on the live step
// while the user browses. A pure controller decision (no byte risk), so `model`
// only — no `screen`/overlapGroup twin.

scenario(
  {
    name: 'browsing the selection up and down does not detach the running step from live focus',
    feature: 'nav',
    drivers: ['model'],
    risk: 'selection-decoupled-from-live',
    oldTestRefs: [
      'tests/integration/lifecycle/nav.up-down-moves-selection-without-detaching-live.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a paused live run (review is the running/live step)
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })
    await app.leftPane.assertStepSelected('review')
    await app.leftPane.assertGlyph('review', 'running')

    // when — the user browses the preview cursor up to an earlier step
    await app.leftPane.browseTo('plan')

    // then — the preview cursor moved, but the live step is untouched: it keeps
    // its running glyph AND remains the committed (right-pane-tracking) selection
    await app.leftPane.assertPreviewCursorOn('plan')
    await app.leftPane.assertGlyph('review', 'running')
    await app.leftPane.assertStepSelected('review')
  },
)
