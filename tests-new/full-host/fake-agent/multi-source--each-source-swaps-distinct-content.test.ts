import { emits, scenario } from '../../dsl/index.ts'

// Migration (parent U6b.2). Consolidates `many-sources-no-split-failure` and the
// `per-source-sessions-10-step-walkthrough`: many per-source sessions, each
// landing in its OWN session, and swapping the visible slot shows distinct
// content per source — at a representative scale (3 sources, not a slow 10-step
// real-tmux walkthrough). Each source's per-pane `[<step>] starting…` marker is
// the deterministic distinct-content signal. The no-split-window-failure /
// no-leak / teardown-reaps-every-session property is guaranteed by the U2 driver
// no-orphans/teardown regression — referenced, not re-asserted here.

scenario(
  {
    name: 'each per-source step lands in its own session and swapping shows that source distinct content',
    feature: 'multi-source',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-plumbing-at-scale',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/many-sources-no-split-failure.real.integration.test.ts',
      'tests/integration/lifecycle/per-source-sessions-10-step-walkthrough.real.test.ts',
    ],
  },
  async (app) => {
    // given — several per-source steps
    await app.launch({ steps: ['alpha', 'beta', 'gamma'], agent: emits('thinking') })

    // when — the workflow completes (the visible slot followed live to the last)
    await app.complete('gamma')
    await app.rightPane.assertShowsContent('[gamma] starting')

    // then — swapping the visible slot to each earlier source shows THAT source's
    // distinct content (each landed in its own per-source session; no split-window
    // failure, proven structurally by the U2 driver regression)
    await app.leftPane.selectStep('alpha')
    await app.rightPane.assertShowsContent('[alpha] starting')

    await app.leftPane.selectStep('beta')
    await app.rightPane.assertShowsContent('[beta] starting')

    await app.rightPane.assertNoCaretEcho()
  },
)
