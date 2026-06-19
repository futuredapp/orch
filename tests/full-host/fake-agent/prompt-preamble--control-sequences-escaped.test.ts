import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-6 / AE6. A prompt containing escape/control sequences is shown as
// visible TEXT, escaped before the bytes reach the per-step tee — not
// interpreted as terminal control codes. The pane (label, separator, agent
// output) stays intact, and the OSC 52 clipboard sub-case proves the sequence
// was escaped, not executed: its raw introducer bytes never survive while its
// payload shows as literal text.

const ESC = '\x1b'
const BEL = '\x07'

// A screen-clear CSI, an SGR colour, an OSC 52 clipboard write with a known
// base64 payload, plus quotes/backslashes/newlines.
const NASTY_PROMPT = [
  `clear-screen ${ESC}[2J then continue`,
  `colour ${ESC}[31m red text`,
  `clipboard ${ESC}]52;c;Y2xpcGJvYXJkLXBheWxvYWQ=${BEL} end`,
  'quotes "double" and \\backslash\\ kept',
].join('\n')

scenario(
  {
    name: 'a prompt with control sequences is shown as escaped text without corrupting the pane',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an autonomous step whose prompt carries control/escape sequences
    await app.launch({
      steps: ['plan'],
      prompts: [NASTY_PROMPT],
      agent: emits('agent output survived the nasty prompt'),
    })

    // when — the step runs to completion
    await app.complete('plan')

    // then — recognizable sequence content appears as VISIBLE text (escaped, not
    // interpreted): the CSI payload and the OSC 52 base64 both show literally
    await app.rightPane.assertShowsContent('[2J then continue')
    await app.rightPane.assertShowsContent('52;c;Y2xpcGJvYXJkLXBheWxvYWQ=')

    // and — the OSC 52 was escaped, not executed: no raw clipboard-write bytes
    // survive in the pane text, AND the decoded payload never reached the tmux
    // paste buffer (with `set-clipboard on`, a passed-through OSC 52 would have
    // populated it — so this assertion is genuinely falsifiable, not vacuous).
    await app.rightPane.assertNoOsc52()
    await app.rightPane.assertClipboardUnchanged('clipboard-payload')

    // and — the preamble chrome and the agent output remain intact and readable
    await app.rightPane.assertShowsPromptPreamble()
    await app.rightPane.assertShowsContent('agent output survived the nasty prompt')
    await app.rightPane.assertNoCaretEcho()
  },
)
