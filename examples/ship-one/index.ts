/**
 * ship-one — minimal single-step subworkflow.
 *
 * The lightest possible sub — one `plan` step, no Args beyond the optional
 * inherited `prompt`. Used by `ship-many` and other parents that want a
 * placeholder "thing that gets done" to compose.
 */

import { step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const PLAN = step.define('plan', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Outline a single shipping action for: {{prompt}}',
})

export default workflow('ship-one', async (run, args) => {
  await run(PLAN, { vars: { prompt: args.prompt ?? '' } })
})
