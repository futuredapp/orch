# Interactive steps

> **What you'll learn:** how to pause for human input with `ask()`, drive an agent's real TUI with `mode: 'interactive'`, and keep both working in unattended CI.

"Interactive" covers two different things in orch: asking the *human* a question (`ask()`), and running an *agent's* terminal UI in a pane (`mode: 'interactive'`). This recipe covers both. Runnable references: the [`ask-demo`](/examples) and [`feature-loop`](/examples) examples.

## Ask the human a question

`ask()` is a step that renders a prompt with optional text fields and a row of buttons, then returns a typed, discriminated result:

```ts
// .orch/workflows/review-gate.ts
import { workflow, ask } from 'orch'

const ASK_CONTINUE = ask({
  name: 'continue',
  question: 'Continue this iteration? (retry re-runs work; abort exits)',
  fields: { notes: { placeholder: 'extra instructions (optional)' } },
  buttons: ['continue', 'retry', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

export default workflow('review-gate', async (run) => {
  const answer = await run(ASK_CONTINUE)

  if (answer.cancelled) return // user pressed Esc / Ctrl-D

  if (answer.button === 'abort') return
  if (answer.button === 'retry') {
    const extra = answer.notes.trim() // typed: the `notes` field
    // ... re-run a step with `extraPrompt: extra`
  }
  // 'continue' falls through
})
```

The result is a discriminated union. Check `cancelled` first; in the `cancelled: false` branch, `answer.button` is narrowed to one of your literal button names and each field (`answer.notes`) is a string. The full shape is in the [`ask` reference](/reference/api#ask).

## Make it work in CI

A prompt with no human at the keyboard would hang. `defaultWhenNoninteractive` declares what the `ask()` resolves to under `--noninteractive` (or `ORCH_NONINTERACTIVE=1`):

```bash
orch run review-gate --noninteractive
```

In that mode `ASK_CONTINUE` resolves to `{ cancelled: false, button: 'continue', notes: '' }` without rendering anything, so the same workflow runs end-to-end in CI. An `ask()` with no `defaultWhenNoninteractive` errors under `--noninteractive` — orch will not silently guess.

## Drive an agent's TUI

An agent step normally runs autonomously. Set `mode: 'interactive'` to spawn the agent's real terminal UI in a pane so you can talk to it directly:

```ts
import { workflow, step, claude } from 'orch'

const BRAINSTORM = step.define('brainstorm', {
  agent: claude(),
  mode: 'interactive',
  prompt: '/workflows:brainstorm',
})

export default workflow('compound', async (run) => {
  await run(BRAINSTORM) // you drive Claude in the pane; the run resumes when you exit
})
```

This needs [two-pane mode](/guide/3-core-concepts#run-modes) (a TTY plus tmux). The workflow blocks at this step until you finish the session and exit the agent.

## Keep an interactive step from stalling a pipeline

If you want the watchable TUI but *not* a human gate, add `autoStop: true`. orch injects a stop hook so that when the agent finishes its turn, the pane closes and the run advances on its own:

```ts
const DRAFT = step.define('draft', {
  agent: claude({ flags: ['--dangerously-skip-permissions'] }),
  mode: 'interactive',
  autoStop: true,
  prompt: 'Draft the changelog entry.',
})
```

Two things matter here: `autoStop` only fires once the agent's turn *completes*, so skip permission prompts (or the turn never ends); and `autoStop` is interactive-only — setting it on an autonomous step is a definition-time error. It requires a runner with auto-stop support (`claude()` and `codex()` qualify).

::: tip Interactive steps can't return structured data
`mode: 'interactive'` and `returns:` are mutually exclusive — structured output needs the agent to run autonomously. `step.define` throws at definition time if you combine them. Use [typed returns](/guides/typed-returns) on autonomous steps.
:::

## Where to go next

- [Typed returns](/guides/typed-returns) — structured data from autonomous steps.
- [Chain two agents](/guides/chain-two-agents) — the autonomous counterpart of this recipe.
- [`ask` reference](/reference/api#ask) — every field and the full result type.
