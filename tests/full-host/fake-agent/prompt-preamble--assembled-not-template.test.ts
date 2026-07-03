import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-8. The displayed prompt is the ASSEMBLED text the agent received —
// task text plus orch-injected context/overrides — not the pre-assembly
// template. The scenario sends a base prompt PLUS an injected fragment (the
// runner's `extraPrompt` override, which `assemblePrompt` appends), then asserts
// the injected marker shows in the pane. Because the run is real, the displayed
// text is necessarily the prompt the runner received, not a re-rendered template.

scenario(
  {
    name: 'the displayed prompt is the assembled text including orch-injected context, not the template',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an autonomous step whose assembled prompt is a base task plus an
    // injected marker appended by orch at assembly time
    await app.launch({
      steps: ['plan'],
      prompts: ['BASE-TASK summarize the changes'],
      extraPrompt: 'INJECTED-CONTEXT-MARKER repo conventions apply',
      agent: emits('agent ran'),
    })

    // when — the step runs to completion
    await app.complete('plan')

    // then — the pane shows BOTH the base task and the orch-injected marker (it
    // is the assembled, post-injection prompt — not only the template text)
    await app.rightPane.assertShowsContent('BASE-TASK summarize the changes')
    await app.rightPane.assertShowsContent('INJECTED-CONTEXT-MARKER repo conventions apply')
    await app.rightPane.assertNoCaretEcho()
  },
)
