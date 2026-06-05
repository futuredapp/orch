import { emits, scenario } from '../../dsl/index.ts'

// Migration (parent U6a.4). Covers `replay-shows-same-transcript-as-live` and the
// visible half of `replay-revisit-reuses-pane`: after a single step completes,
// its transcript persists in the right pane, and revisiting it shows the SAME
// transcript (the warm-cached source is reused, not respawned). Single-step, so
// the agent transcript TEXT is deterministic (the flush race only bites
// multi-step instant FakeRunners). The white-box pane-COUNT invariant of the old
// `replay-revisit` test is `drop` — an implementation detail, covered
// structurally by the U2 driver no-orphans regression.

scenario(
  {
    name: 'a completed step keeps its transcript in the right pane and revisiting it shows the same transcript',
    feature: 'replay',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/replay-shows-same-transcript-as-live.real.integration.test.ts',
      'tests/integration/hosts/two-pane/tier-1/replay-revisit-reuses-pane.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a single step that emits a known transcript line
    await app.launch({ steps: ['plan'], agent: emits('persistent thinking') })

    // when — the step runs to completion
    await app.complete('plan')

    // then — the transcript persists in the right pane after the run ends
    await app.rightPane.assertShowsContent('persistent thinking')

    // when — the user revisits the completed step
    await app.leftPane.selectStep('plan')

    // then — the same transcript is shown again (warm-cached source reused)
    await app.rightPane.assertShowsContent('persistent thinking')
    await app.rightPane.assertNoCaretEcho()
  },
)
