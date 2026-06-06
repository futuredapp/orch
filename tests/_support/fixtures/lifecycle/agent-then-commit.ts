/**
 * `behavioral-agent-then-commit` — Tier 5 fixture for Group D #13.
 *
 * Three steps:
 *   1. `worktree:feat-orch-d13` — creates and enters a worktree so the commit
 *      step has its own branch.
 *   2. `work` (puppet) — writes `note.txt` in the worktree cwd.
 *   3. `commit:add-note` — stages and commits.
 *
 * After completion, the new branch should contain a commit with the message
 * "add note".
 */

import { commit, createWorktree, step, workflow } from '../../../../src/core/index.ts'
import { scriptedFake } from '../../../../src/runners/scripted-fake/index.ts'

const WORK = step.define('work', {
  agent: scriptedFake({ stepName: 'work' }),
  prompt: 'behavioral: agent-then-commit (puppet)',
})

const wf = workflow('behavioral-agent-then-commit', async (run) => {
  await run(createWorktree('feat/orch-d13', { enter: true }))
  await run(WORK)
  await run(commit('add note'))
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
