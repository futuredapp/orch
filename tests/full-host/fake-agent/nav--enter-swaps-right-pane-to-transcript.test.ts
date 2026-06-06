import { emits, scenario } from '../../dsl/index.ts'

// Migration (parent U6a.3). Enter on a COMPLETED step swaps the RIGHT pane to
// that step's transcript and flips the left-pane footer to viewing mode — the
// core two-pane communication behaviour of `nav.enter-…`. Static mode (the whole
// FakeRunner workflow runs to completion), then navigation drives the mounted
// host, so the swap is proven on real tmux. Per-step `agents` give each step a
// DISTINCT transcript marker so the swap is unambiguous (not the live source
// re-shown).

scenario(
  {
    name: 'pressing Enter on a completed step swaps the right pane to its transcript and flips the footer',
    feature: 'nav',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [
      'tests/integration/lifecycle/nav.enter-on-completed-step-swaps-right-pane-to-transcript.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a two-step run (each per-source pane carries a deterministic
    // `[<step>] starting…` marker; the live agent transcript text races teardown
    // under instant FakeRunners, so the per-source marker is the stable signal
    // of WHICH source the visible right pane is showing — exactly as the old
    // tier-1 multi-step test asserts).
    await app.launch({ steps: ['plan', 'execute'], agent: emits('thinking') })

    // when — the workflow runs to completion (right pane auto-advanced to the
    // last live step, `execute`)
    await app.complete('execute')
    await app.rightPane.assertShowsContent('[execute] starting')

    // and — the user selects the earlier completed step
    await app.leftPane.selectStep('plan')

    // then — the right pane swaps to plan's source and the left committed
    // selection lands on plan. (The live↔replay footer-flip *chrome* is proven
    // in live mode by the U5b `view-mode-footer` model/screen scenarios; a
    // completed static run renders the terminal footer, so the two-pane
    // communication risk — the right-pane swap — is what this scenario owns.)
    await app.rightPane.assertShowsContent('[plan] starting')
    await app.leftPane.assertStepSelected('plan')
    await app.rightPane.assertNoCaretEcho()
  },
)
