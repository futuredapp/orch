/**
 * favourite-animal — the smallest possible "run Claude Code" workflow.
 *
 * A single interactive Claude step. The prompt instructs Claude to ask the
 * human exactly one question about their favourite animal using its built-in
 * AskUserQuestion tool, then acknowledge the answer and stop.
 *
 *   1. ask-animal  → interactive, claude  → Claude asks one AskUserQuestion
 *
 * Because the step is `mode: 'interactive'`, the human answers Claude's
 * question live in the agent pane.
 *
 * Usage (two-pane Ink renderer — needed to answer Claude interactively):
 *   bunx orch run favourite-animal --mode=two-pane
 *
 * Usage (plain readline):
 *   bunx orch run favourite-animal
 *
 * Requirements: `claude` must be on PATH.
 */

import { claude, step, workflow } from 'orch'

const ASK_ANIMAL = step.define('ask-animal', {
  agent: claude({
    bare: false,
    permissions: 'bypass',
  }),
  mode: 'interactive',
  prompt:
    'Ask me exactly one question: what is my favourite animal? ' +
    'You MUST ask it using the AskUserQuestion tool — offer a few animal ' +
    'options (e.g. dog, cat, otter) plus the usual free-form choice. ' +
    'Once I answer, reply with one short friendly sentence about that animal ' +
    'and then stop. Do not ask any further questions.',
})

export default workflow('favourite-animal', async (run) => {
  await run(ASK_ANIMAL)
})
