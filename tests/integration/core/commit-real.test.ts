import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { commit } from '../../../src/core/commit.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path as orchPath,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

const canRun = Bun.which('git') !== null

let tmpDirs: string[] = []

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

/**
 * Creates a temporary git repo with a single initial commit.
 * Returns the absolute path to the repo root.
 */
async function tempGitRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp('/tmp/orch-git-real-')
  tmpDirs.push(tmpDir)
  const exec = async (cmd: string) => {
    const proc = Bun.spawn(['sh', '-c', cmd], {
      cwd: tmpDir,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`Command failed: ${cmd}`)
  }
  await exec('git init')
  await exec('git config user.name "Test"')
  await exec('git config user.email "test@test.com"')
  await exec('echo "init" > README.md')
  await exec('git add .')
  await exec('git commit -m "initial"')
  return tmpDir
}

async function makeDeps(
  repoDir: string,
  runId?: RunId,
): Promise<WorkflowDeps & { gitService: BunGitService }> {
  const processService = new BunProcessService()
  const bunFs = new BunFsService()
  // State dir lives OUTSIDE the git repo so it doesn't dirty the tree
  const stateDir = await fs.mkdtemp('/tmp/orch-git-state-')
  tmpDirs.push(stateDir)
  return {
    processService,
    clock: new BunClock(),
    fsService: bunFs,
    gitService: new BunGitService({ processService }),
    stateStore: new FileStateStore({ fs: bunFs, basePath: orchPath(stateDir) }),
    runId: runId ?? ('r-2026-04-13-638488-e2' as RunId),
    cwd: orchPath(repoDir),
    host: createFakeHost(),
  }
}

describe.skipIf(!canRun)('commit step with real git', () => {
  it('creates a commit and returns the new HEAD SHA', async () => {
    const repoDir = await tempGitRepo()
    const deps = await makeDeps(repoDir)

    // Create a file so the tree is dirty
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'content')

    // Get HEAD before commit
    const beforeSha = await deps.gitService.headSha(orchPath(repoDir))

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(commit('checkpoint'))
    })
    await wf.execute(deps)

    // Result should be an object with sha
    expect(result).toBeDefined()
    expect(result).toHaveProperty('sha')
    const commitResult = result as { sha: string }
    expect(commitResult.sha).toMatch(/^[0-9a-f]{40}$/)

    // SHA should differ from before
    expect(commitResult.sha).not.toBe(beforeSha)

    // HEAD should now match the returned sha
    const afterSha = await deps.gitService.headSha(orchPath(repoDir))
    expect(afterSha).toBe(commitResult.sha)
  })

  it('returns null on clean tree', async () => {
    const repoDir = await tempGitRepo()
    const deps = await makeDeps(repoDir)

    // Tree is already clean after initial commit

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(commit('nothing'))
    })
    await wf.execute(deps)

    expect(result).toBeNull()
  })

  it('returns cached result on resume', async () => {
    const repoDir = await tempGitRepo()
    const runId = 'r-2026-04-13-416112-w6' as RunId
    // Shared state dir so both runs see the same persisted state
    const stateDir = await fs.mkdtemp('/tmp/orch-git-state-')
    tmpDirs.push(stateDir)

    const makeSharedDeps = (): WorkflowDeps => {
      const processService = new BunProcessService()
      const bunFs = new BunFsService()
      return {
        processService,
        clock: new BunClock(),
        fsService: bunFs,
        gitService: new BunGitService({ processService }),
        stateStore: new FileStateStore({ fs: bunFs, basePath: orchPath(stateDir) }),
        runId,
        cwd: orchPath(repoDir),
        host: createFakeHost(),
      }
    }

    // Create a file so the tree is dirty
    await fs.writeFile(path.join(repoDir, 'new-file.txt'), 'content')

    // First run: commit succeeds
    let firstResult: unknown
    const wf1 = workflow('test', async (run) => {
      firstResult = await run(commit('checkpoint'))
    })
    await wf1.execute(makeSharedDeps())

    // Second run: same runId, tree is now clean — should return cached value
    let secondResult: unknown
    const wf2 = workflow('test', async (run) => {
      secondResult = await run(commit('checkpoint'))
    })
    await wf2.execute(makeSharedDeps())

    expect(secondResult).toEqual(firstResult)
  })
})
