import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-5 / AE5. A several-hundred-line prompt is shown verbatim, with the
// agent output pushed below it and nothing elided / truncated.
//
// Phase-1 observation note: the live/replay pane auto-follows to the tail (the
// open-at-top behaviour is R9 / Phase 3), and the real-tmux capture reads the
// VISIBLE viewport, so a several-hundred-line prompt's HEAD is scrolled above
// the fold here. This scenario therefore asserts the prompt's far end + the
// separator + the agent output are present verbatim at the bottom (proving the
// tail reached the pane uneilded). The complementary "no head truncation"
// guarantee — that prompt sources read from the START of the file rather than
// the bounded `tail -n 5000` window — is covered by the focused unit substitute
// the plan sanctions (the choreographer registers the live source with
// `fromStart: true`, and the renderer unit renders a 400-line prompt in full).

const FIRST = 'PROMPT-HEAD-MARKER first line of a very long prompt'
const LAST = 'PROMPT-TAIL-MARKER final line of a very long prompt'

function longPrompt(): string {
  const middle = Array.from({ length: 300 }, (_, i) => `context line ${i}`)
  return [FIRST, ...middle, LAST].join('\n')
}

scenario(
  {
    name: 'a several-hundred-line prompt is shown verbatim with the agent output below it',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an autonomous step whose assembled prompt is several hundred lines
    await app.launch({
      steps: ['plan'],
      prompts: [longPrompt()],
      agent: emits('agent output after a long prompt'),
    })

    // when — the step runs to completion
    await app.complete('plan')

    // then — the far end of the prompt, the separator, and the agent output are
    // all present verbatim (the tail is not truncated or replaced by a marker)
    await app.rightPane.assertShowsContent(LAST)
    await app.rightPane.assertShowsPromptSeparator()
    await app.rightPane.assertShowsContent('agent output after a long prompt')
    await app.rightPane.assertNoCaretEcho()
  },
)
