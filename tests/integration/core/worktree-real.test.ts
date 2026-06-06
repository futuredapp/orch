import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { createTempGitRepo, type TempGitRepo } from '@orch/test/temp-git-repo.ts'
import { commit } from '../../../src/core/commit.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createWorktree, type WorktreeResult } from '../../../src/core/worktree.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  GitCommandError,
  path as orchPath,
  type Path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const canRun = Bun.which('git') !== null

// Tracked so afterEach can `git worktree remove --force` before deleting dirs.
interface TrackedWorktree {
  readonly repo: Path
  readonly path: string
}

let repos: TempGitRepo[] = []
let stateDirs: string[] = []
let worktrees: TrackedWorktree[] = []

afterEach(async () => {
  // Worktrees first — a registered worktree blocks the underlying repo cleanup.
  for (const wt of worktrees) {
    await runGitRaw(wt.repo, ['git', 'worktree', 'remove', '--force', wt.path]).catch(() => {})
    await fs.rm(wt.path, { recursive: true, force: true })
  }
  worktrees = []
  for (const repo of repos) {
    await repo.cleanup()
  }
  repos = []
  for (const dir of stateDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  stateDirs = []
})

async function makeRepo(): Promise<TempGitRepo> {
  const repo = await createTempGitRepo()
  repos.push(repo)
  return repo
}

async function makeDeps(repoCwd: Path, runId?: RunId): Promise<WorkflowDeps> {
  const stateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'orch-wt-real-state-'))
  stateDirs.push(stateDir)
  const processService = new BunProcessService()
  const bunFs = new BunFsService()
  return {
    processService,
    clock: new BunClock(),
    fsService: bunFs,
    gitService: new BunGitService({ processService }),
    stateStore: new FileStateStore({ fs: bunFs, basePath: orchPath(stateDir) }),
    runId: runId ?? ('r-2026-04-30-200000-w1' as RunId),
    cwd: repoCwd,
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

interface GitOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

async function runGitRaw(cwd: Path | string, argv: readonly string[]): Promise<GitOutcome> {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd: cwd as string,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Orch Test',
      GIT_AUTHOR_EMAIL: 'orch-test@example.invalid',
      GIT_COMMITTER_NAME: 'Orch Test',
      GIT_COMMITTER_EMAIL: 'orch-test@example.invalid',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function git(cwd: Path | string, argv: readonly string[]): Promise<string> {
  const out = await runGitRaw(cwd, argv)
  if (out.exitCode !== 0) {
    throw new Error(`git ${argv.slice(1).join(' ')} failed (${out.exitCode}): ${out.stderr}`)
  }
  return out.stdout
}

describe.skipIf(!canRun)('createWorktree — real git', () => {
  it('creates a worktree at the sibling default with branch off HEAD; git worktree list reflects it', async () => {
    const repo = await makeRepo()

    let result: WorktreeResult | undefined
    const wf = workflow('worktree-happy', async (run) => {
      result = await run(createWorktree('feat/foo', { enter: false }))
    })
    const deps = await makeDeps(repo.cwd)
    await wf.execute(deps)

    expect(result).toBeDefined()
    const wt = result as WorktreeResult
    worktrees.push({ repo: repo.cwd, path: wt.path })

    expect(wt.branch).toBe('feat/foo')
    expect(wt.fromRef).toBe('HEAD')
    // Sibling layout: <parent>/<projectName>--feat-foo
    expect(nodePath.basename(wt.path)).toMatch(/--feat-foo$/)

    // The new worktree dir exists on disk.
    const stat = await fs.stat(wt.path)
    expect(stat.isDirectory()).toBe(true)

    // git worktree list (machine-readable) includes the new path.
    const listing = await git(repo.cwd, ['git', 'worktree', 'list', '--porcelain'])
    const registered = listing
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
    // Resolve symlinks (macOS /tmp → /private/tmp) before comparing.
    const realWtPath = await fs.realpath(wt.path)
    const realRegistered = await Promise.all(registered.map((p) => fs.realpath(p).catch(() => p)))
    expect(realRegistered).toContain(realWtPath)

    // The branch was created and HEAD inside the worktree points to it.
    const branchInside = (await git(wt.path, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    expect(branchInside).toBe('feat/foo')
  })

  it('from: "main" creates a worktree based off the main branch', async () => {
    const repo = await makeRepo()
    // Add a second commit on main so HEAD diverges from `main` after we move HEAD.
    // Then move HEAD off main (detach) so HEAD != main, proving `from: 'main'` was honoured.
    await fs.writeFile(nodePath.join(repo.cwd, 'one.txt'), 'one')
    await git(repo.cwd, ['git', 'add', '.'])
    await git(repo.cwd, ['git', 'commit', '-m', 'second'])
    const mainSha = (await git(repo.cwd, ['git', 'rev-parse', 'main'])).trim()
    // Move HEAD back to seed (different SHA from main) so `from: 'main'` matters.
    await git(repo.cwd, ['git', 'checkout', '--detach', repo.seedCommit])

    let result: WorktreeResult | undefined
    const wf = workflow('worktree-from-main', async (run) => {
      result = await run(createWorktree('feat/from-main', { enter: false, from: 'main' }))
    })
    const deps = await makeDeps(repo.cwd)
    await wf.execute(deps)

    const wt = result as WorktreeResult
    worktrees.push({ repo: repo.cwd, path: wt.path })

    expect(wt.fromRef).toBe('main')

    // The new branch's HEAD must equal main's SHA, not the outer HEAD.
    const wtSha = (await git(wt.path, ['git', 'rev-parse', 'HEAD'])).trim()
    expect(wtSha).toBe(mainSha)
  })

  it('enter: true; a subsequent commit step lands a commit on the new branch', async () => {
    const repo = await makeRepo()

    let wtResult: WorktreeResult | undefined
    let commitResult: { sha: string } | null | undefined
    const wf = workflow('worktree-then-commit', async (run) => {
      wtResult = await run(
        createWorktree('feat/work', {
          enter: true,
          // Use postCreate sugar to dirty the new worktree's tree so commit() has something to do.
          postCreate: ['echo "from worktree" > $TARGET/inside.txt'],
        }),
      )
      commitResult = (await run(commit('inside the worktree'))) as { sha: string } | null
    })
    const deps = await makeDeps(repo.cwd)
    await wf.execute(deps)

    const wt = wtResult as WorktreeResult
    worktrees.push({ repo: repo.cwd, path: wt.path })

    expect(commitResult).not.toBeNull()
    const sha = (commitResult as { sha: string }).sha
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    // The commit must land inside the worktree, on feat/work — verified via git log.
    const branchHead = (await git(wt.path, ['git', 'rev-parse', 'HEAD'])).trim()
    expect(branchHead).toBe(sha)
    const branchName = (await git(wt.path, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    expect(branchName).toBe('feat/work')

    // The original repo's HEAD (still on main) must NOT have advanced — the
    // commit happened inside the worktree, not in the parent repo.
    const mainHead = (await git(repo.cwd, ['git', 'rev-parse', 'main'])).trim()
    expect(mainHead).toBe(repo.seedCommit)

    // The committed file is present in the worktree.
    const inside = await fs.readFile(nodePath.join(wt.path, 'inside.txt'), 'utf8')
    expect(inside).toBe('from worktree\n')
  })

  it('postCreate sugar with $ORIGIN and $TARGET runs cp / touch and produces the expected files', async () => {
    const repo = await makeRepo()
    // Seed a file in the origin repo that the sugar form will copy.
    await fs.writeFile(nodePath.join(repo.cwd, 'env-source.txt'), 'origin payload')
    await git(repo.cwd, ['git', 'add', '.'])
    await git(repo.cwd, ['git', 'commit', '-m', 'add env-source'])

    let result: WorktreeResult | undefined
    const wf = workflow('worktree-postcreate-sugar', async (run) => {
      result = await run(
        createWorktree('feat/sugar', {
          enter: false,
          postCreate: [
            'cp "$ORIGIN/env-source.txt" "$TARGET/copied.txt"',
            'touch "$TARGET/marker"',
          ],
        }),
      )
    })
    const deps = await makeDeps(repo.cwd)
    await wf.execute(deps)

    const wt = result as WorktreeResult
    worktrees.push({ repo: repo.cwd, path: wt.path })

    const copied = await fs.readFile(nodePath.join(wt.path, 'copied.txt'), 'utf8')
    expect(copied).toBe('origin payload')
    const marker = await fs.stat(nodePath.join(wt.path, 'marker'))
    expect(marker.isFile()).toBe(true)
  })

  it('a pre-existing branch produces a clear GitCommandError', async () => {
    const repo = await makeRepo()
    // Create the branch up-front so the pre-flight check trips.
    await git(repo.cwd, ['git', 'branch', 'feat/existing'])

    let caught: unknown
    const wf = workflow('worktree-branch-conflict', async (run) => {
      await run(createWorktree('feat/existing', { enter: false }))
    })
    const deps = await makeDeps(repo.cwd)
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(GitCommandError)
    expect((caught as Error).message).toContain('feat/existing')
    expect((caught as Error).message).toContain('already exists')

    // No stray worktree on disk — pre-flight bailed before `git worktree add`.
    const listing = await git(repo.cwd, ['git', 'worktree', 'list', '--porcelain'])
    const registered = listing.split('\n').filter((l) => l.startsWith('worktree '))
    expect(registered).toHaveLength(1) // only the source repo itself
  })

  it('a pre-existing worktree path produces a clear GitCommandError', async () => {
    const repo = await makeRepo()
    // Pre-register a worktree at the exact path createWorktree() will compute.
    const projectName = nodePath.basename(repo.cwd)
    const expectedTarget = nodePath.join(nodePath.dirname(repo.cwd), `${projectName}--feat-collide`)
    await git(repo.cwd, ['git', 'worktree', 'add', '-b', 'pre-collide', expectedTarget, 'HEAD'])
    worktrees.push({ repo: repo.cwd, path: expectedTarget })

    let caught: unknown
    const wf = workflow('worktree-path-conflict', async (run) => {
      await run(createWorktree('feat/collide', { enter: false }))
    })
    const deps = await makeDeps(repo.cwd)
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(GitCommandError)
    expect((caught as Error).message).toContain('already registered')
    // Path mention must include the intended target so the error is actionable.
    expect((caught as Error).message).toContain('feat-collide')
  })
})
