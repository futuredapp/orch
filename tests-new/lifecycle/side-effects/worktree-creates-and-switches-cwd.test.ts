/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/worktree.creates-real-git-worktree-and-switches-cwd.behavioral.real.test.ts`.
 *
 * Side effect: `createWorktree(..., { enter: true })` materializes a git worktree
 * on disk (visible to `git worktree list`) and subsequent steps run inside the
 * new path — the agent step's file lands under the worktree dir, not the repo
 * root. Relocation parity: same assertions, new path.
 */

import * as nodePath from 'node:path'
import { describe, it } from 'bun:test'
import {
  assertFilesystem,
  assertGit,
  awaitRunStatus,
  awaitStepStatus,
  fileExistsAt,
  puppet,
  withinMs,
  worktreeExists,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — worktree creates a real git worktree', () => {
  it('git worktree list reports the branch and the agent step lands inside it', async () => {
    const handle = await withOrchHandle('worktree-then-agent', {
      script: { work: puppet() },
      initGitRepo: true,
    })

    await awaitStepStatus('worktree:feat-orch-d11', 'completed', { timeoutMs: 15_000 })

    // Worktree visible via porcelain output before the agent step writes anything.
    await assertGit(withinMs(5_000), worktreeExists('feat/orch-d11'))

    // The puppet step writes inside its cwd — which is the worktree, not the repo root.
    await handle.agent('work').writeFile('plan.md', '# plan inside worktree\n')
    await handle.agent('work').complete()
    await awaitRunStatus('completed', { timeoutMs: 10_000 })

    // Default `target: 'sibling'` lands at `<dirname(repoRoot)>/<basename(repoRoot)>--<slug>`.
    const worktreePath = nodePath.join(
      nodePath.dirname(handle.repoRoot),
      `${nodePath.basename(handle.repoRoot)}--feat-orch-d11`,
    )
    await assertFilesystem(withinMs(5_000), fileExistsAt(nodePath.join(worktreePath, 'plan.md')))
  }, 45_000)
})
