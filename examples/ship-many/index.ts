/**
 * ship-many — homogeneous parallel of TWO different subs (`ship-a`, `ship-b`).
 *
 * v1's R20 collision contract forbids invoking the SAME sub twice in one run,
 * so a parallel "ship the same thing three times" example trips the guard.
 * The canonical parallel-of-subs shape uses N distinct subs in a parallel
 * block, each carrying a different `prompt`. The parallel runtime's
 * `branchStore` marks every step inside as `insideParallel: true`, which the
 * two-pane projector reads via R23 to render the rollup flat (no `▼`/`✓`
 * boundary rows).
 */

import { parallel, runWorkflow, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

// Two distinct subworkflows. Each is a single-step body, distinguished only
// by name — that's enough to honour the single-invocation contract.
const PLAN_A = step.define('plan', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Plan shipping branch A for: {{prompt}}',
})

const PLAN_B = step.define('plan', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Plan shipping branch B for: {{prompt}}',
})

const shipA = workflow('ship-a', async (run, args) => {
  await run(PLAN_A, { vars: { prompt: args.prompt ?? '' } })
})

const shipB = workflow('ship-b', async (run, args) => {
  await run(PLAN_B, { vars: { prompt: args.prompt ?? '' } })
})

const branches = [
  { name: 'ship-a', sub: shipA },
  { name: 'ship-b', sub: shipB },
] as const

export default workflow('ship-many', async (_run, args) => {
  await parallel(branches, async (branch) => {
    await runWorkflow(branch.sub, { prompt: args.prompt ?? '' })
  })
})
