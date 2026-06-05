import { scenario } from '../dsl/index.ts'

// Migration (parent U5b / D-P2). Banner TTL is a DECISION OVER TIME and lives
// only on `model`, driven by the VIRTUAL clock (`advanceTime`): an info banner
// auto-clears after its TTL; an error banner persists past it. A `screen` test
// must NEVER wait real wall-clock for a TTL (the exact flake the drivers exist
// to kill), so this scenario is model-only and carries no `overlapGroup`.

scenario(
  {
    name: 'an info banner auto-clears after its TTL while an error banner persists',
    feature: 'banner',
    drivers: ['model'],
    risk: 'banner-ttl',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx',
      'tests/integration/lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts',
      'tests/integration/lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // info: shows, then auto-clears once the virtual clock passes the TTL
    await app.emitBanner('info', 'step complete')
    await app.leftPane.assertInfoBannerShows('step complete')
    await app.advanceTime(4000)
    await app.leftPane.assertBannerCleared('step complete')

    // error: shows and PERSISTS past the same elapsed time
    await app.emitBanner('error', 'step plan failed')
    await app.leftPane.assertErrorBannerShows('step plan failed')
    await app.advanceTime(60_000)
    await app.leftPane.assertErrorBannerShows('step plan failed')
  },
)
