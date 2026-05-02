/**
 * ask-demo — exercises the `ask()` step on its own (no Claude needed).
 *
 * Three prompts back-to-back:
 *
 *   1. ask:start    → single button "begin", proves the simplest shape works.
 *   2. ask:profile  → two text fields (name, color) + buttons (save, skip).
 *   3. ask:confirm  → multi-button decision (yes, no, maybe) with a notes field.
 *
 * Each step's typed result is logged so you can see what the workflow author
 * gets back. Cancel at any prompt (Esc in two-pane, Ctrl-D in plain) and the
 * workflow exits cleanly via the discriminated `cancelled: true` branch.
 *
 * Usage (interactive, plain readline):
 *   bunx orch run ask-demo
 *
 * Usage (interactive, two-pane Ink renderer — needs tmux):
 *   bunx orch run ask-demo --mode=two-pane
 *
 * Usage (autonomous, declared defaults):
 *   bunx orch run ask-demo --noninteractive
 */

import { ask, workflow } from '../../src/core/index.ts'

const ASK_START = ask({
  name: 'start',
  question: 'Ready to start the demo?',
  buttons: ['begin'],
  defaultWhenNoninteractive: { button: 'begin' },
})

const ASK_PROFILE = ask({
  name: 'profile',
  question: 'Tell me about yourself (both fields are optional):',
  fields: {
    name: { placeholder: 'your name' },
    color: { placeholder: 'favorite color' },
  },
  buttons: ['save', 'skip'],
  defaultWhenNoninteractive: { button: 'skip' },
})

const ASK_CONFIRM = ask({
  name: 'confirm',
  question: 'Did the demo work as expected?',
  fields: { notes: { placeholder: 'feedback (optional)' } },
  buttons: ['yes', 'no', 'maybe'],
  defaultWhenNoninteractive: { button: 'yes' },
})

export default workflow('ask-demo', async (run) => {
  const start = await run(ASK_START)
  if (start.cancelled) {
    console.log('[ask-demo] cancelled at start; nothing to do.')
    return
  }
  console.log('[ask-demo] start →', start)

  const profile = await run(ASK_PROFILE)
  if (profile.cancelled) {
    console.log('[ask-demo] cancelled at profile; partial fields:', profile.fields)
    return
  }
  console.log('[ask-demo] profile →', profile)

  // NOTE: the AskResult TS type spreads fields at top-level (`profile.name`),
  // but the runtime nests them under `fields` (`profile.fields.name`). The
  // type and runtime are currently misaligned — using runtime shape here so
  // the demo actually runs.
  const profileFields = (profile as unknown as { fields: { name: string; color: string } }).fields
  if (profile.button === 'save') {
    const name = profileFields.name.trim() || '(no name)'
    const color = profileFields.color.trim() || '(no color)'
    console.log(`[ask-demo] hello ${name} — your favorite color is ${color}.`)
  } else {
    console.log('[ask-demo] profile skipped.')
  }

  const confirm = await run(ASK_CONFIRM)
  if (confirm.cancelled) {
    console.log('[ask-demo] cancelled at confirm.')
    return
  }
  console.log('[ask-demo] confirm →', confirm)

  const confirmFields = (confirm as unknown as { fields: { notes: string } }).fields
  const notes = confirmFields.notes.trim()
  console.log(`[ask-demo] done. verdict=${confirm.button}${notes ? ` notes="${notes}"` : ''}`)
})
