/**
 * Behavioral cell — `createWorktree({ postCreate: ['touch sentinel.txt'] })`
 * actually executes the shell command inside the new worktree. After the
 * step completes, `sentinel.txt` exists at the worktree path.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  awaitRunStatus,
  fileExistsAt,
  launchOrchWorkflow,
  type OrchHandle,
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

// MIGRATED → tests-new/lifecycle/side-effects/worktree-post-create-shell-command.test.ts — parent U8 (G4).
// port: fs side effect (postCreate shell command creates a file in the worktree).
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — worktree postCreate shell', () => {
  it.skip('postCreate ["touch sentinel.txt"] creates the file inside the worktree', async () => {
    handle = await launchOrchWorkflow('worktree-with-post-create', {
      initGitRepo: true,
    })

    await awaitRunStatus('completed', { timeoutMs: 15_000 })

    const worktreePath = nodePath.join(
      nodePath.dirname(handle.repoRoot),
      `${nodePath.basename(handle.repoRoot)}--feat-orch-d12`,
    )
    await assertFilesystem(
      withinMs(5_000),
      fileExistsAt(nodePath.join(worktreePath, 'sentinel.txt')),
    )
  }, 30_000)
})
