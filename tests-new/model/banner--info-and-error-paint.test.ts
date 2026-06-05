import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `model` half of BANNER paint: an info banner shows
// its text; an error banner shows its text wrapped in the `! … · Esc dismiss`
// envelope; with no banner emitted, neither appears. Byte twin shares
// `banner-paint`. (TTL behaviour is a SEPARATE, model-only scenario — D-P2.)

scenario(
  {
    name: 'an info banner and an error banner each render with their expected envelope',
    feature: 'banner',
    drivers: ['model'],
    risk: 'banner-paint',
    overlapGroup: 'banner-paint',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/banner-rendering.test.tsx',
      'tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx',
    ],
  },
  async (app) => {
    // given — a live run with no banner
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })
    await app.leftPane.assertContentAbsent('saved to disk')

    // when — an info banner is emitted
    await app.emitBanner('info', 'saved to disk')
    await app.leftPane.assertInfoBannerShows('saved to disk')

    // when — an error banner replaces it
    await app.emitBanner('error', 'disk full')
    await app.leftPane.assertErrorBannerShows('disk full')
  },
)
