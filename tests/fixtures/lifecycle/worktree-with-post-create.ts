/**
 * `behavioral-worktree-with-post-create` — Tier 5 fixture for Group D #12.
 *
 * One worktree step whose `postCreate` sugar runs `touch sentinel.txt` inside
 * the new worktree dir. After completion the sentinel file should exist on
 * disk under the worktree path. No agent step needed — the assertion is on
 * the worktree side-effect alone.
 */

import { createWorktree, workflow } from '../../../src/core/index.ts'

const wf = workflow('behavioral-worktree-with-post-create', async (run) => {
  await run(
    createWorktree('feat/orch-d12', {
      enter: true,
      postCreate: ['touch sentinel.txt'],
    }),
  )
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
