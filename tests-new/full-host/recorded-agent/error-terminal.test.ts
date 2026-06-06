import { fromCassette, scenario } from '../../dsl/index.ts'

// Recorded-agent realism (parent U9/W3, §9.6). The risk is EVENT-STREAM SHAPE
// at the FAILURE end: a turn that ends on `terminal.type: 'error'`. The inline
// `emits(...)` fake only ever finishes successfully, so the failure-render path
// has no fake equivalent — only a recorded error cassette exercises it. Replays
// deterministically through the fake-agent engine on the real two-pane host:
// no CLI, no network, no flake; proves the failure outcome paints (not a hang,
// not a crash).
//
// Born new (no old twin). Re-record out-of-band via
// `record.ts --scenario claude-error-terminal` only if drift is suspected (D9).

scenario(
  {
    name: 'an error-terminal turn replays and the failure outcome paints in the right pane',
    feature: 'transcript-rendering',
    drivers: ['full-host:recorded-agent'],
    risk: 'event-stream-shape',
    oldTestRefs: [],
  },
  async (app) => {
    // given — a cassette whose turn ends on an error terminal
    await app.launch({ steps: ['migrate'], agent: fromCassette('claude-error-terminal.json') })

    // when — the recorded step runs to its failing terminal
    await app.complete('migrate')

    // then — the failure message reached the visible right pane
    await app.rightPane.assertShowsContent('migration failed: constraint violation')
  },
)
