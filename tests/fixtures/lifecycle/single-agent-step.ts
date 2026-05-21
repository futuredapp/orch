/**
 * `behavioral-single-agent-step` — minimal Tier 5 fixture for Batch 1 cells.
 *
 * One autonomous agent step (`work`) wired to ScriptedFakeRunner. Tests pair
 * with `puppet()` and drive the step via `handle.agent('work').*`.
 */

import { step, workflow } from '../../../src/core/index.ts'
import { scriptedFake } from '../../../src/runners/scripted-fake/index.ts'

const WORK = step.define('work', {
  agent: scriptedFake({ stepName: 'work' }),
  prompt: 'behavioral: single agent step (puppet-driven)',
})

const wf = workflow('behavioral-single-agent-step', async (run) => {
  await run(WORK)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
