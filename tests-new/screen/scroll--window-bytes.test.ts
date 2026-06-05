import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `screen` byte twin of the scroll model member:
// the viewport window must render correctly at a small pane HEIGHT off real
// tmux — the oldest row genuinely off-screen, scroll keys bringing it back.
// Shares the `scroll-window` overlap group with §model.

scenario(
  {
    name: 'scrolling a small real-tmux pane reveals an off-window step and returns to the tail',
    feature: 'scroll',
    drivers: ['screen'],
    risk: 'scroll-window-bytes',
    overlapGroup: 'scroll-window',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx'],
  },
  async (app) => {
    // given — a short pane and more steps than fit
    await app.resize(80, 12)
    await app.launch({
      steps: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'],
      stopAt: 'mid-step',
    })

    await app.leftPane.assertStepOffscreen('a01')
    await app.leftPane.scrollToOldest()
    await app.leftPane.assertStepVisible('a01')
    await app.leftPane.scrollToLive()
    await app.leftPane.assertStepVisible('a10')
  },
)
