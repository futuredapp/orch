import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-7 / AE4 — INTERIM (logging-on) regression only, NOT the R8
// acceptance. With file logging on (every real run + this harness), live and
// replay tail the SAME frozen `formatted_output.ansi`, so the preamble written
// live at step:start is already embedded for replay with no extra code. The
// always-on, logger-INDEPENDENT store that closes R8 / AT-7 acceptance lands in
// Phase 2 — this scenario guards that the live-path embedding survives a revisit.

scenario(
  {
    name: 'revisiting a completed autonomous step still shows its prompt above the replayed output',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — a completed autonomous run whose step was sent a known prompt
    await app.launch({
      steps: ['plan'],
      prompts: ['REPLAY-PROMPT reconstruct the same context'],
      agent: emits('agent output to replay'),
    })
    await app.complete('plan')

    // when — the step is reselected (replay path)
    await app.leftPane.selectStep('plan')

    // then — the same prompt appears above the replayed output, as it did live
    await app.rightPane.assertShowsPromptPreamble()
    await app.rightPane.assertShowsContent('REPLAY-PROMPT reconstruct the same context')
    await app.rightPane.assertShowsContent('agent output to replay')
    await app.rightPane.assertNoCaretEcho()
  },
)
