/**
 * worktree-demo — minimal demonstration of `createWorktree()` chained with
 * `commit()`. Runs against the current repo: creates a sibling worktree on a
 * fresh branch off HEAD, the workflow's cwd switches into it, and a commit
 * step lands a no-op commit (the tree is clean → CommitResult is null).
 *
 * The point of this example is to compile in CI as a static reference for
 * `docs/getting-started.md`. It does not invoke an agent runner.
 *
 * Usage:
 *   bun run examples/worktree-demo/index.ts
 *
 * Requirements: this script must run inside a git checkout. The new branch
 * `demo/worktree-example` and the sibling directory must not already exist;
 * remove them with `git worktree remove --force` and `git branch -D` if
 * re-running.
 */

import * as nodePath from 'node:path'
import {
  commit,
  createWorktree,
  type WorkflowDeps,
  workflow,
} from '../../src/core/index.ts'
import { createPlainHost } from '../../src/hosts/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../../src/services/index.ts'
import { FileStateStore, generateRunId } from '../../src/state/index.ts'

const here = import.meta.dir
const stateDir = nodePath.join(here, 'state')

const clock = new BunClock()
const processService = new BunProcessService()
const runIdVal = generateRunId({ clock })

const deps: WorkflowDeps = {
  stateStore: new FileStateStore({ fs: new BunFsService(), basePath: path(stateDir) }),
  processService,
  clock,
  gitService: new BunGitService({ processService }),
  fsService: new BunFsService(),
  runId: runIdVal,
  cwd: path(process.cwd()),
  host: createPlainHost({
    stdout: process.stdout,
    stderr: process.stderr,
    format: 'text',
    clock,
    runId: runIdVal,
    processService,
  }),
}

const wf = workflow('worktree-demo', async (run) => {
  // Create a sibling worktree off HEAD. `enter: true` switches the workflow's
  // cwd, so subsequent run() calls (commit() below) operate inside it.
  const wt = await run(
    createWorktree('demo/worktree-example', {
      enter: true,
      // postCreate runs after the worktree is materialised — sugar form runs
      // each line via /bin/sh -c with $ORIGIN and $TARGET in env. Out of scope
      // for this static example; uncomment if you want to wire a fresh env:
      // postCreate: ['cp $ORIGIN/.env .', 'bun install'],
    }),
  )
  console.log(`[orch] created worktree at ${wt.path} from ${wt.fromRef}`)

  // Inside the worktree now. A real workflow would land an agent step here
  // (claude({...}) etc.) before committing the changes.
  const c = await run(commit('demo: worktree commit'))
  console.log(`[orch] commit result: ${c === null ? '(clean)' : c.sha}`)
})

console.log(`[orch] runId = ${deps.runId}`)
console.log(`[orch] state = ${stateDir}`)

await wf.execute(deps)
