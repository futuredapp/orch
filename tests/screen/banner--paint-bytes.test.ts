import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `screen` byte twin of banner paint: an info banner
// and an error banner each render above the steps grid off real tmux. No
// temporal assertion here — TTL is model-only on a virtual clock (D-P2/R-P2);
// a `screen` test must never wait real wall-clock. Shares `banner-paint`.

scenario(
  {
    name: 'info and error banners paint above the steps grid as real tmux bytes',
    feature: 'banner',
    drivers: ['screen'],
    risk: 'banner-paint-bytes',
    overlapGroup: 'banner-paint',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/banner-rendering.test.tsx',
      'tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx',
    ],
  },
  async (app) => {
    // given — an info banner at launch
    await app.resize(80, 24)
    await app.launch({
      steps: ['plan'],
      stopAt: 'mid-step',
      banner: { kind: 'info', text: 'saved to disk' },
    })
    await app.leftPane.assertInfoBannerShows('saved to disk')

    // when — re-launched with an error banner, the `! … · Esc dismiss` envelope paints
    await app.launch({
      steps: ['plan'],
      stopAt: 'mid-step',
      banner: { kind: 'error', text: 'disk full' },
    })
    await app.leftPane.assertErrorBannerShows('disk full')
  },
)
