// Shared test helpers for worktree executor tests. Lives under tests/ so it
// stays out of the prod barrel.

import type { Path, RunId } from '../../../src/core/types.ts'
import { path } from '../../../src/core/types.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
} from '../../../src/services/index.ts'
import { FileStateStore } from '../../../src/state/index.ts'
import { createFakeHost, type FakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId

const BASE = path('/runs')

export interface TestDeps extends WorkflowDeps {
  readonly fs: FakeFsService
  readonly processService: FakeProcessService
  readonly clock: FakeClock
  readonly gitService: FakeGitService
  readonly fsService: FakeFsService
  readonly host: FakeHost
}

export function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  clock?: FakeClock
  runId?: RunId
  gitService?: FakeGitService
  cwd?: Path
}): TestDeps {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = overrides?.clock ?? new FakeClock(1000)
  const gitService = overrides?.gitService ?? new FakeGitService()
  return {
    fs,
    fsService: fs,
    gitService,
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-30-100000-w1'),
    cwd: overrides?.cwd ?? path('/workspace/proj'),
    host: createFakeHost(),
  }
}

export const REPO_ROOT = path('/workspace/proj')

export function setupRepoRoot(git: FakeGitService, cwd: Path = REPO_ROOT): void {
  git.setRepoRoot(cwd, cwd)
}

export function expectedSiblingPath(slug: string): Path {
  return path(`/workspace/proj--${slug}`)
}

/** Sets up the fake to allow a successful createWorktree() call against `cwd`. */
export function scriptHappyWorktree(deps: TestDeps, branch: string): Path {
  setupRepoRoot(deps.gitService, deps.cwd)
  const slug = branch.replace(/\//g, '-')
  const target = expectedSiblingPath(slug)
  deps.gitService.setBranchExists(deps.cwd, branch, false)
  deps.gitService.setWorktreePathExists(deps.cwd, target, false)
  deps.gitService.allowAddWorktree(deps.cwd)
  return target
}

/** Spy runner that captures `ctx.cwd` on each invocation. */
export function makeCwdSpy(argv: readonly string[], capture: (cwd: string) => void): Runner {
  return defineRunner({
    name: 'cwd-spy',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      capture(ctx.cwd)
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  })
}
