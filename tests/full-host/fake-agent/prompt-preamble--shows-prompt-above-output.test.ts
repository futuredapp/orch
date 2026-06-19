import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-1 / AE1 and AT-2. The show-initial-prompt feature: an autonomous
// step's right pane leads with the exact prompt orch sent the agent — a
// `prompt:` label, the prompt text, a separator — above the agent's streamed
// output. Driven through real tmux so the risk "do these bytes reach the real
// pane" is exercised, not asserted on a controller projection.
//
// Triage: this would go red if the preamble were never written at step:start,
// if the label/separator chrome drifted from production, or if the prompt sat
// below the agent output — so it passes the testing-strategy "would it still
// pass if the behaviour were wrong?" gate.

scenario(
  {
    name: 'an autonomous step shows its prompt with a label and separator above the agent output',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — one autonomous step whose assembled prompt is a known line, and a
    // fake agent that emits a distinct output line
    await app.launch({
      steps: ['plan'],
      prompts: ['Investigate the flaky login test and propose a fix.'],
      agent: emits('agent is now reasoning'),
    })

    // when — the step runs to completion
    await app.complete('plan')

    // then — the pane shows the `prompt:` label, the prompt text, and a separator
    await app.rightPane.assertShowsPromptPreamble()
    await app.rightPane.assertShowsContent('Investigate the flaky login test')

    // and — the agent's own output is shown too (it flows below the preamble)
    await app.rightPane.assertShowsContent('agent is now reasoning')
    await app.rightPane.assertNoCaretEcho()
  },
)
