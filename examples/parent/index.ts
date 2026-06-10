/**
 * parent — cwd-isolation parent for the subworkflow guide.
 *
 * Demonstrates that `setWorkflowCwd` inside a subworkflow does NOT leak back
 * to the parent's frame. `runWorkflow` pushes a fresh ALS sub-frame where
 * `workflowCwd` is COPIED BY VALUE; the sub's writes mutate the sub-frame's
 * field only, and the parent's subsequent `run()` calls keep using the
 * parent's cwd.
 *
 * Pair this with the matching `branch-isolated` sub which uses
 * `createWorktree({ enter: true })` to switch cwd. After the sub returns the
 * parent's pwd is unchanged.
 */

import { claude, runWorkflow, step, workflow } from 'orch'
import branchIsolated from '../branch-isolated/index.ts'

const HELLO = step.define('hello', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Say hello from the parent workflow cwd.',
})

const REPORT = step.define('report', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Confirm that the parent cwd has been restored after the sub returned.',
})

export default workflow('parent', async (run, args) => {
  await run(HELLO)
  await runWorkflow(branchIsolated, { prompt: args.prompt ?? '' })
  await run(REPORT)
})
