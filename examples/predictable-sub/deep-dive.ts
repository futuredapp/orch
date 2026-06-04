/**
 * deep-dive — DEV-ONLY subworkflow driven by the predictable fake agent.
 *
 * Composed into `predictable-sub` via `runWorkflow(deepDive, …)`. Its only job
 * is to be a drivable, screenshot-able SUB so the QA toolkit can verify that a
 * subworkflow visibly launches (its steps appear nested under the parent in the
 * left pane). Both steps are interactive Ink panes, so the QA agent addresses
 * them by their namespaced keys (`deep-dive>investigate`, `deep-dive>summarize`
 * — discover them with `qa awaiting`).
 *
 * DEV-ONLY: deep-imports `scriptedFake`, which is intentionally absent from the
 * public barrels. Never include in a shipped config. See predictable-tui.
 */

import { step, workflow } from '../../src/core/index.ts'
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'

const ink = (stepName: string) => scriptedFake({ stepName, interactive: true, interactiveUi: 'ink' })

const INVESTIGATE = step.define('investigate', {
  mode: 'interactive',
  agent: ink('investigate'),
  prompt: 'Investigate inside the subworkflow. Drive me from qa or by hand.',
})

const SUMMARIZE = step.define('summarize', {
  mode: 'interactive',
  agent: ink('summarize'),
  prompt: 'Summarize the sub findings. Same two drive channels.',
})

export default workflow('deep-dive', async (run) => {
  await run(INVESTIGATE)
  await run(SUMMARIZE)
})
