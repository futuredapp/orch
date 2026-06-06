/**
 * Behavioral cell — a `commit(...)` step after a worktree + agent step
 * produces a real git commit on the worktree's branch with the expected
 * message visible via `git log`.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertGit,
  awaitRunStatus,
  awaitStepStatus,
  commitExists,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

// MIGRATED → tests-new/lifecycle/side-effects/commit-step-creates-real-commit.test.ts — parent U8 (G4).
// port: git side effect (a real commit on the worktree branch).
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — commit step creates real commit', () => {
  it.skip('git log on the worktree branch shows the commit added by the commit step', async () => {
    handle = await launchOrchWorkflow('agent-then-commit', {
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
