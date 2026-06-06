import { emits, scenario } from '../../dsl/index.ts'

// Migration (parent U6a.4). `multi-step-right-pane-shows-latest`: a user who
// never navigates away tracks the live edge, so when the first step completes
// and the second starts, the visible right pane must AUTO-ADVANCE to the second
// step's source — and the first step stays warm-cached (revisitable). The
// per-source `[<step>] starting…` marker is the deterministic signal of which
// source the visible pane shows (live transcript text races teardown under
// instant FakeRunners — see the old tier-1 multi-step test's own note).

scenario(
  {
    name: 'the right pane auto-advances to the newest live step while the previous step stays revisitable',
    feature: 'multi-step',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-plumbing',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/multi-step-right-pane-shows-latest.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a two-step run the user never navigates away from
    await app.launch({ steps: ['plan', 'execute'], agent: emits('thinking') })

    // when — both steps complete (the user stayed on the live edge throughout)
    await app.complete('execute')

    // then — the visible right pane auto-advanced onto the second live source
    await app.rightPane.assertShowsContent('[execute] starting')

    // and — the first step stayed warm-cached: revisiting it swaps it back in
    await app.leftPane.selectStep('plan')
    await app.rightPane.assertShowsContent('[plan] starting')
    await app.rightPane.assertNoCaretEcho()
  },
)
