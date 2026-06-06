/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/commit.step-creates-real-commit-on-branch.behavioral.real.test.ts`.
 *
 * Side effect: a `commit(...)` step after a worktree + agent step produces a real
 * git commit on the worktree's branch with the expected message visible via
 * `git log`. Relocation parity: same assertions, new path.
 */

import { describe, it } from 'bun:test'
import {
  assertGit,
  awaitRunStatus,
  awaitStepStatus,
  commitExists,
  puppet,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — commit step creates a real commit', () => {
  it('git log on the worktree branch shows the commit added by the commit step', async () => {
    const handle = await withOrchHandle('agent-then-commit', {
      script: { work: puppet() },
      initGitRepo: true,
    })

    await awaitStepStatus('worktree:feat-orch-d13', 'completed', { timeoutMs: 15_000 })

    await handle.agent('work').writeFile('note.txt', 'hello from puppet\n')
    await handle.agent('work').complete()
    await awaitRunStatus('completed', { timeoutMs: 15_000 })

    await assertGit(withinMs(5_000), commitExists('feat/orch-d13', 'add note'))
  }, 45_000)
})
