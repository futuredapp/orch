/**
 * steps-tui-demo — canonical walkthrough for the two-pane Steps TUI.
 *
 * Mixes every kind of step the steps navigator surfaces so you can practice
 * each per-kind Enter behavior in under two minutes:
 *
 *   1. command:plan-files       → captured pane log; Enter replays it.
 *   2. parallel review          → 2 autonomous Claude branches; transcripts
 *                                 stream in the right pane.
 *   3. brainstorm (interactive) → opens Claude in window 0; on completion
 *                                 the step is selectable; Enter resumes the
 *                                 captured Claude session in window 1.
 *   4. commit:demo              → details panel shows sha + diff stat.
 *   5. command:summary          → captured pane log of `wc -l`.
 *
 * Usage:
 *   bunx orch run steps-tui-demo --mode=two-pane "anything"
 *
 * Keymap inside the TUI:
 *   ↑/↓   move selection through past steps
 *   ⏎     inspect the selected step (per-kind action)
 *   f     follow the live step (close inspect window)
 *   ?     toggle the keymap overlay
 *   q     quit the TUI; the run continues silently
 *
 * Requires `claude` on PATH for the parallel + interactive Claude steps. The
 * two `command:` steps work without any agent CLI installed, so you can also
 * exercise the command-replay path on its own with --mode=two-pane.
 */

import { claude, command, commit, parallel, step, workflow } from 'orch'

const AUTONOMOUS = claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] })

const PLAN_FILES = command('plan-files', {
  argv: ['/bin/sh', '-c', 'ls -1 *.md 2>/dev/null || true'],
  onFailure: 'continue',
})

const REVIEW_SECURITY = step.define('review-security', {
  agent: AUTONOMOUS,
  prompt: 'Skim the README of this repo and call out one security risk in two sentences.',
})

const REVIEW_DESIGN = step.define('review-design', {
  agent: AUTONOMOUS,
  prompt: 'Skim the README of this repo and call out one design improvement in two sentences.',
})

const BRAINSTORM = step.define('brainstorm', {
  mode: 'interactive',
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Help me think through how I would extend the steps TUI. Two short turns is enough.',
})

const SUMMARY = command('summary', {
  argv: ['/bin/sh', '-c', "echo 'demo done' | wc -l"],
  onFailure: 'continue',
})

export default workflow('steps-tui-demo', async (run) => {
  await run(PLAN_FILES)
  await parallel([run(REVIEW_SECURITY), run(REVIEW_DESIGN)])
  await run(BRAINSTORM)
  await run(commit('demo: steps-tui walkthrough'))
  await run(SUMMARY)
})
