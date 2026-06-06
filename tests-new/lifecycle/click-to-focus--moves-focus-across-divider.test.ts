import { holdsOpen, scenario } from '../dsl/index.ts'

// G2 (parent U8) — click-to-focus across the pane divider. Appliance-mode
// installs a server-side click-to-focus binding; this re-derives
// `click-to-focus-across-divider-smoke` using the W1 `click`/`assertFocused`
// affordances, round-tripping the mouse-event builder and the focus matcher over
// real tmux. Lifecycle is the only driver that models real cross-pane focus.

scenario(
  {
    name: 'clicks move focus between the left and right panes',
    feature: 'click-to-focus',
    drivers: ['lifecycle'],
    risk: 'attached-cli-ui',
    oldTestRefs: ['tests/integration/lifecycle/click-to-focus-across-divider-smoke.real.test.ts'],
  },
  async (app) => {
    // given — a held step so the host is mounted and interactive
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — click the right pane → it becomes focused
    await app.click('right')
    await app.rightPane.assertFocused()

    // when — click back on the left pane → focus moves over
    await app.click('left')
    await app.leftPane.assertFocused()
  },
)
