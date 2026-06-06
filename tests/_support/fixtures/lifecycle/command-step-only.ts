/**
 * `behavioral-command-step-only` — Tier 5 fixture for Group D #14.
 *
 * Two steps:
 *   1. `command:echo` — runs `echo orch-d14-marker`; output should stream to
 *      the right pane and `state.json` should record `exitCode: 0`.
 *   2. `hold` — a puppet step that keeps the run alive so the test can
 *      observe the right-pane capture before orch exits. Without this, the
 *      echo finishes in ~6ms and tmux is torn down before the probe runs.
 */

import { command, step, workflow } from '../../../../src/core/index.ts'
import { scriptedFake } from '../../../../src/runners/scripted-fake/index.ts'

const HOLD = step.define('hold', {
  agent: scriptedFake({ stepName: 'hold' }),
  prompt: 'behavioral: hold the run for right-pane observation (puppet)',
})

const wf = workflow('behavioral-command-step-only', async (run) => {
  await run(
    command('echo', {
      argv: ['echo', 'orch-d14-marker'],
      onFailure: 'halt',
    }),
  )
  await run(HOLD)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
