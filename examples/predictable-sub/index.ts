/**
 * predictable-sub — DEV-ONLY. A parent workflow that dispatches into a
 * predictable-fake SUBWORKFLOW (`deep-dive`) so the QA toolkit can verify the
 * canonical subworkflow scenario end-to-end WITHOUT real agents:
 *
 *   triage (interactive)  →  runWorkflow(deep-dive)  →  report (interactive)
 *
 * When `triage` finishes, the run enters `deep-dive`; its steps appear nested
 * under the parent in the left pane (the visible "subworkflow launched" signal
 * the QA agent screenshots and asserts on). Drive it with:
 *
 *   cd examples && bun ../src/cli/main.ts run predictable-sub --mode=two-pane --no-attach
 *   # then, from the repo root:
 *   bun examples/qa/qa.ts awaiting          # discover the next addressable step key
 *
 * DEV-ONLY: deep-imports `scriptedFake` (non-public). Never ship in a config.
 */

import { runWorkflow, step, workflow } from '../../src/core/index.ts'
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'
import deepDive from './deep-dive.ts'

const ink = (stepName: string) => scriptedFake({ stepName, interactive: true, interactiveUi: 'ink' })

const TRIAGE = step.define('triage', {
  mode: 'interactive',
  agent: ink('triage'),
  prompt: 'Triage the request. Finish me to launch the deep-dive subworkflow.',
})

const REPORT = step.define('report', {
  mode: 'interactive',
  agent: ink('report'),
  prompt: 'Report after the subworkflow returns. Same two drive channels.',
})

export default workflow('predictable-sub', async (run) => {
  await run(TRIAGE, { as: 'triage' })
  await runWorkflow(deepDive, {})
  await run(REPORT, { as: 'report' })
})
