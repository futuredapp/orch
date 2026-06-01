/**
 * branch-isolated — subworkflow that switches into a fresh worktree.
 *
 * Inside the sub-frame `createWorktree({ enter: true })` is safe — the cwd
 * mutation is bounded to the sub-frame's ALS slot and DOES NOT leak back to
 * the parent. The matching parent example (`examples/parent`) chains a
 * `hello` step → `runWorkflow(branchIsolated, args)` → `report` step and
 * relies on this isolation contract.
 */

import { createWorktree, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const WORK = step.define('work', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Make a small change inside the worktree for: {{prompt}}',
})

export default workflow('branch-isolated', async (run, args) => {
  await run(
    createWorktree('demo/subworkflow-sandbox', {
      enter: true,
    }),
  )
  await run(WORK, { vars: { prompt: args.prompt ?? '' } })
})
