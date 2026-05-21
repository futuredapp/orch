/**
 * `behavioral-worktree-then-agent` — Tier 5 fixture for Group D #11.
 *
 * Two steps:
 *   1. `worktree:feat-orch-d11` (from createWorktree('feat/orch-d11', { enter: true }))
 *      Materialises a real git worktree at a sibling path and switches the
 *      workflow cwd to it.
 *   2. `work` (puppet) — runs INSIDE the worktree. Test asserts the worktree
 *      exists on disk and the puppet's cwd resolves under it (via writeFile).
 */

import { createWorktree, step, workflow } from '../../../src/core/index.ts'
import { scriptedFake } from '../../../src/runners/scripted-fake/index.ts'

const WORK = step.define('work', {
  agent: scriptedFake({ stepName: 'work' }),
  prompt: 'behavioral: worktree-then-agent (puppet)',
})

const wf = workflow('behavioral-worktree-then-agent', async (run) => {
  await run(createWorktree('feat/orch-d11', { enter: true }))
  await run(WORK)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
