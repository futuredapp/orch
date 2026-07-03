import { emits, scenario } from '../../dsl/index.ts'

// Covers AT-9 (R9). When an autonomous step whose prompt is taller than the
// pane opens, the pane is scrolled to the TOP of the prompt — the `prompt:`
// label and the prompt's head are visible — and it does NOT auto-follow past
// the prompt to the latest agent output. The accepted trade-off: live output
// sits below the fold until the watcher scrolls down.
//
// Why this is a real RED→GREEN for the pin: the real-tmux pane is 50 rows, and
// the prompt below is ~120 lines. Without R9 the pane auto-tails (its sibling
// `--long-prompt-verbatim` scenario asserts exactly that: the TAIL is shown and
// the head is scrolled off). With R9 the controller enters copy-mode at the top
// of history on step open, so the HEAD is visible and the agent output — known
// to have been produced (the step completed) — is below the visible fold.
//
// Observed through the COPY-MODE-AWARE viewport (`assertOpenedAtPromptTop`):
// tmux `capture-pane -p` reports the live screen even when the pane is scrolled
// up in copy-mode, so the harness reconstructs the visible window from the
// pane's scroll position to see what a watcher actually sees.

const HEAD = 'PROMPT-HEAD-MARKER the first line of an over-height prompt'
const TAIL = 'PROMPT-TAIL-MARKER the final line of an over-height prompt'
const AGENT_OUTPUT = 'AGENT-OUTPUT-MARKER streamed below the fold'

function overHeightPrompt(): string {
  // 120 body lines + head + tail ⇒ well past the 50-row pane, so the head can
  // only be visible if the viewport is pinned to the top.
  const middle = Array.from({ length: 120 }, (_, i) => `context line ${i}`)
  return [HEAD, ...middle, TAIL].join('\n')
}

scenario(
  {
    name: 'an over-height autonomous step opens scrolled to the top of the prompt',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an autonomous step whose assembled prompt exceeds the pane height
    await app.launch({
      steps: ['plan'],
      prompts: [overHeightPrompt()],
      agent: emits(AGENT_OUTPUT),
    })

    // when — the step runs to completion (so the agent output is definitely on
    // the stream; the pin must keep it below the fold, not merely race ahead of
    // it)
    await app.complete('plan')

    // then — the visible viewport shows the prompt's HEAD (pinned to the top)
    // while the agent output sits below the fold (scrolled out of view)
    await app.rightPane.assertOpenedAtPromptTop(HEAD, AGENT_OUTPUT)
    // …and the prompt's far end is likewise below the fold
    await app.rightPane.assertOpenedAtPromptTop(HEAD, TAIL)
    await app.rightPane.assertNoCaretEcho()
  },
)

// Guard (R9): a SHORT autonomous prompt is unaffected — pinning to the top of
// history when the whole prompt + output fits on screen still shows the label,
// separator, and the agent output normally (nothing is hidden by the pin).
const SHORT_PROMPT = 'a short single-purpose prompt'
const SHORT_AGENT_OUTPUT = 'agent output for the short-prompt guard'

scenario(
  {
    name: 'a short-prompt autonomous step still shows the preamble and output after the top-pin',
    feature: 'prompt-preamble',
    drivers: ['full-host:fake-agent'],
    risk: 'two-pane-communication',
    oldTestRefs: [],
  },
  async (app) => {
    // given — an autonomous step whose prompt fits comfortably in the pane
    await app.launch({
      steps: ['plan'],
      prompts: [SHORT_PROMPT],
      agent: emits(SHORT_AGENT_OUTPUT),
    })

    // when — the step runs to completion
    await app.complete('plan')

    // then — the preamble (label + separator + prompt) AND the agent output are
    // all visible; the top-pin does not strand a short prompt's output below a
    // fold that does not exist
    await app.rightPane.assertShowsPromptPreamble()
    await app.rightPane.assertShowsContent(SHORT_PROMPT)
    await app.rightPane.assertShowsContent(SHORT_AGENT_OUTPUT)
    await app.rightPane.assertNoCaretEcho()
  },
)
