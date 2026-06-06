/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/worktree.post-create-shell-command-creates-file.behavioral.real.test.ts`.
 *
 * Side effect: `createWorktree({ postCreate: ['touch sentinel.txt'] })` executes
 * the shell command inside the new worktree — after the step completes,
 * `sentinel.txt` exists at the worktree path. Relocation parity: same
 * assertions, new path.
 */

import * as nodePath from 'node:path'
import { describe, it } from 'bun:test'
import {
  assertFilesystem,
  awaitRunStatus,
  fileExistsAt,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — worktree postCreate shell command', () => {
  it('postCreate ["touch sentinel.txt"] creates the file inside the worktree', async () => {
    const handle = await withOrchHandle('worktree-with-post-create', {
      initGitRepo: true,
    })

    await awaitRunStatus('completed', { timeoutMs: 15_000 })

    const worktreePath = nodePath.join(
      nodePath.dirname(handle.repoRoot),
      `${nodePath.basename(handle.repoRoot)}--feat-orch-d12`,
    )
    await assertFilesystem(withinMs(5_000), fileExistsAt(nodePath.join(worktreePath, 'sentinel.txt')))
  }, 30_000)
})
