import { fromCassette, scenario } from '../../dsl/index.ts'

// Tracer for the `full-host:recorded-agent` driver (parent U3, §9.6). Replays a
// realistic event stream — captured once from a real run, checked in as a
// cassette — deterministically through the fake-agent engine on the real
// two-pane host. No CLI, no network, no flake: the cassette is the only input.
//
// The cassette carries a realistic `tool_use` event plus an assistant line; we
// assert the rendered assistant CONTENT via the escape hatch (the cassette's
// own authored text), which is what FakeRunner.toTranscriptLines surfaces on the
// real terminal (resolves the parent §8 deferred right-pane-assertion question).

scenario(
  {
    name: 'a recorded Claude plan→work run paints its transcript in the right pane',
    feature: 'transcript-rendering',
    drivers: ['full-host:recorded-agent'],
    risk: 'event-stream-shape',
    oldTestRefs: [],
  },
  async (app) => {
    // given — realistic events, captured once, replayed deterministically
    await app.launch({ steps: ['plan'], agent: fromCassette('claude-plan-then-work.json') })

    // when — the recorded step runs to completion
    await app.complete('plan')

    // then — the recorded transcript reached the visible right pane
    await app.rightPane.assertShowsContent('plan recorded')
  },
)
