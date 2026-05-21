/**
 * Behavioral cell — `createWorktree(..., { enter: true })` actually
 * materializes a git worktree on disk (visible to `git worktree list`) and
 * subsequent steps run inside the new path. The agent step writes a file via
 * its puppet driver and we verify the file lands under the worktree dir, not
 * the original repo root.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  assertGit,
  awaitRunStatus,
  awaitStepStatus,
  fileExistsAt,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  withinMs,
  worktreeExists,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — worktree creates real git worktree', () => {
  it('git worktree list reports the branch and the agent step lands inside it', async () => {
    handle = await launchOrchWorkflow('worktree-then-agent', {
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

    // Default `target: 'sibling'` lands at `<dirname(repoRoot)>/<projectName>--<slug>`.
    // src/core/worktree.ts:resolveTargetPath builds the leaf as `${basename(repoRoot)}--${slug}`.
    const worktreePath = nodePath.join(
      nodePath.dirname(handle.repoRoot),
      `${nodePath.basename(handle.repoRoot)}--feat-orch-d11`,
    )
    await assertFilesystem(withinMs(5_000), fileExistsAt(nodePath.join(worktreePath, 'plan.md')))
  }, 45_000)
})
