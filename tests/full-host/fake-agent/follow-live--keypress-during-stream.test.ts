import { live, scenario } from '../../dsl/index.ts'

// Migration (parent U4.5, K6). The unblock of the DEFERRED Tier-1 placeholder
// `follow-live-returns-to-running-step` — which the old harness could not write
// because a synchronous fire-and-forget FakeRunner left no window to INTERLEAVE
// a user action with live agent output (see the old file's header). The
// live-driven (`scriptedFake`) submode opens that window: the agent streams,
// the test OBSERVES mid-run, the user issues a follow-live keypress mid-stream,
// and further output still reaches the visible right pane.
//
// `app.agent` is reachable ONLY because `liveDriven: true` (parent §9.5, D-P2.3).
// Content is asserted via the escape hatch (test-authored text, D10/K6).

scenario(
  {
    name: 'a follow-live keypress interleaves with the live stream and the typed content keeps showing',
    feature: 'follow-live',
    drivers: ['full-host:fake-agent'],
    liveDriven: true,
    risk: 'live-stream-interleave',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a live step the test drives step-by-step
    await app.launch({ steps: ['work'], agent: live() })
    const agent = app.agent
    if (agent === undefined) throw new Error('expected app.agent on a liveDriven build')

    // when — the agent streams a line, observed MID-RUN (impossible under the
    // old fire-and-forget harness)
    await agent.type('first live thought')
    await app.rightPane.assertShowsContent('first live thought')

    // and the user issues a follow-live keypress while the step is still live
    await app.leftPane.followLive()

    // then — further streamed output still reaches the visible right pane, with
    // no caret-notation echo
    await agent.type('second live thought')
    await app.rightPane.assertShowsContent('second live thought')
    await app.rightPane.assertNoCaretEcho()

    await agent.finish()
  },
)
