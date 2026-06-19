import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-3 / AE2. In a multi-step run, each autonomous step shows ITS OWN
// prompt — the preamble is keyed per step, not per run. The second step's pane
// must show the second prompt, and revisiting the first step must show the
// first prompt (and not the second).

scenario(
  {
    name: 'each autonomous step in a multi-step run shows its own prompt',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — two autonomous steps sent distinct prompts
    await app.launch({
      steps: ['plan', 'execute'],
      prompts: ['PROMPT-ALPHA draft the plan', 'PROMPT-BRAVO carry out the plan'],
      agent: emits('working'),
    })

    // when — both steps complete (the user never navigated away)
    await app.complete('execute')

    // then — the visible pane auto-advanced onto the second step's own prompt
    await app.rightPane.assertShowsContent('PROMPT-BRAVO carry out the plan')

    // and — revisiting the first step shows the first prompt, not the second
    await app.leftPane.selectStep('plan')
    await app.rightPane.assertShowsContent('PROMPT-ALPHA draft the plan')
    await app.rightPane.assertDoesNotShow('PROMPT-BRAVO carry out the plan')
    await app.rightPane.assertNoCaretEcho()
  },
)
