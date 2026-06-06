import { emits, scenario } from '../../dsl/index.ts'

// Tracer for the `full-host:fake-agent` driver (parent U2, §9.5). Proves the
// whole seam end-to-end on real tmux: a scripted autonomous agent's transcript
// reaches the VISIBLE right pane after the step starts, with no caret-notation
// echo. This is the "right pane is empty after step:start" bug class, re-derived
// through the scenario/driver DSL.

scenario(
  {
    name: 'autonomous transcript reaches the right pane with no caret echo',
    feature: 'follow-live',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a fake agent scripted to emit known text (static = default)
    await app.launch({ steps: ['plan'], agent: emits('first thinking', 'second thinking') })

    // when — the step runs to completion
    await app.complete('plan')

    // then — actual bytes off real tmux; test-authored CONTENT via the escape
    // hatch, byte-hygiene via the semantic method
    await app.rightPane.assertShowsContent('first thinking')
    await app.rightPane.assertNoCaretEcho()
  },
)
