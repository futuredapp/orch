import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { stepName } from '../../../src/core/types.ts'
import { BunFsService, BunGitService, BunProcessService } from '../../../src/services/index.ts'
import {
  gitCommitCreated,
  gitDiffCreated,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'
import { createTempGitRepo, type TempGitRepo } from '@orch/test/temp-git-repo.ts'

let repo: TempGitRepo | undefined

afterEach(async () => {
  if (repo) {
    await repo.cleanup()
    repo = undefined
  }
})

function makeServices(): ValidatorServices {
  return {
    fs: new BunFsService(),
    git: new BunGitService({ processService: new BunProcessService() }),
  }
}

function ctxWithBaseline(r: TempGitRepo, baseline: string): ValidatorCtx {
  return {
    stepName: stepName('plan'),
    cwd: r.cwd,
    value: undefined,
    preRunSnapshot: { headSha: baseline },
  }
}

describe('gitDiffCreated + gitCommitCreated (integration, real BunGitService)', () => {
  it('gitDiffCreated fails on a clean repo then passes after an unstaged edit', async () => {
    repo = await createTempGitRepo()
    const services = makeServices()
    const ctx = ctxWithBaseline(repo, repo.seedCommit)

    const before = await gitDiffCreated().run(services, ctx)
    expect(before.ok).toBe(false)

    await fs.writeFile(nodePath.join(repo.cwd, 'hello.txt'), 'hi')
    // Unstaged files don't show in `git diff HEAD` either for untracked
    // files, so stage it — `git add` makes it a tracked edit that diff
    // against HEAD will see.
    const proc = Bun.spawn({
      cmd: ['git', 'add', '.'],
      cwd: repo.cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    await proc.exited

    const after = await gitDiffCreated().run(services, ctx)
    expect(after.ok).toBe(true)
  })

  it('gitCommitCreated fails before a commit and passes after HEAD moves', async () => {
    repo = await createTempGitRepo()
    const services = makeServices()
    const baseline = repo.seedCommit
    const ctx = ctxWithBaseline(repo, baseline)

    const before = await gitCommitCreated().run(services, ctx)
    expect(before.ok).toBe(false)

    // Write a file, commit it, confirm gitCommitCreated flips to ok.
    await fs.writeFile(nodePath.join(repo.cwd, 'hello.txt'), 'hi')
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_AUTHOR_NAME: 'Orch Test',
      GIT_AUTHOR_EMAIL: 'orch@example.invalid',
      GIT_COMMITTER_NAME: 'Orch Test',
      GIT_COMMITTER_EMAIL: 'orch@example.invalid',
    }
    for (const cmd of [
      ['git', 'add', '.'],
      ['git', 'commit', '-q', '-m', 'feat: hello'],
    ]) {
      const p = Bun.spawn({
        cmd,
        cwd: repo.cwd,
        env,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      await p.exited
    }

    const after = await gitCommitCreated().run(services, ctx)
    expect(after.ok).toBe(true)
  })

  it('BunGitService.headSha returns a non-empty SHA on the seeded repo', async () => {
    repo = await createTempGitRepo()
    const git = new BunGitService({ processService: new BunProcessService() })

    const sha = await git.headSha(repo.cwd)

    expect(sha).toMatch(/^[0-9a-f]{7,64}$/)
    expect(sha).toBe(repo.seedCommit)
  })
})

describe('createTempGitRepo helper', () => {
  it('produces a path that exists and a commit SHA shaped like hex', async () => {
    repo = await createTempGitRepo()

    expect(await fs.stat(repo.cwd).then((s) => s.isDirectory())).toBe(true)
    expect(repo.seedCommit).toMatch(/^[0-9a-f]{7,64}$/)
  })

  it('cleanup removes the directory', async () => {
    const r = await createTempGitRepo()

    await r.cleanup()

    let existed = true
    try {
      await fs.stat(r.cwd)
    } catch {
      existed = false
    }
    expect(existed).toBe(false)
    // Set undefined so afterEach does not try to clean again.
    repo = undefined
  })
})
