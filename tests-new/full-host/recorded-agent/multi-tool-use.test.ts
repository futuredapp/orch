import { fromCassette, scenario } from '../../dsl/index.ts'

// Recorded-agent realism (parent U9/W3, §9.6). The risk is EVENT-STREAM SHAPE:
// a turn that fires several `tool_use` events before its assistant line. The
// inline `emits(...)` fake produces only assistant-text lines, so it cannot
// reproduce this multi-event interleave — only a recorded cassette can. Replays
// deterministically through the fake-agent engine on the real two-pane host:
// no CLI, no network, no flake.
//
// Born new (no old twin — the old harness had no realistic-event replay).
// Re-record out-of-band via `record.ts --scenario claude-multi-tool-use` only if
// drift is suspected (D9); the gate replays the checked-in fixture as-is.

scenario(
  {
    name: 'a multi-tool-use turn replays and its assistant summary paints in the right pane',
    feature: 'transcript-rendering',
    drivers: ['full-host:recorded-agent'],
    risk: 'event-stream-shape',
    oldTestRefs: [],
  },
  async (app) => {
    // given — a cassette whose turn fires Read→Grep→Edit before the summary line
    await app.launch({ steps: ['investigate'], agent: fromCassette('claude-multi-tool-use.json') })

    // when — the recorded step runs to completion
    await app.complete('investigate')

    // then — the assistant summary survived the multi-event stream onto the pane
    await app.rightPane.assertShowsContent('investigation complete')
  },
)
