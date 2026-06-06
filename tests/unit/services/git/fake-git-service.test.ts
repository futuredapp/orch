// MIGRATED → tests-new/unit/services/git/fake-git-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { FakeGitService, path } from '../../../../src/services/index.ts'

describe.skip('FakeGitService.headSha', () => {
  it('returns the scripted SHA for the matching cwd', async () => {
    const git = new FakeGitService()
    git.setHeadSha(path('/repo/a'), 'abc1234')

    const sha = await git.headSha(path('/repo/a'))

    expect(sha).toBe('abc1234')
  })

  it('throws a loud error when no SHA is scripted for the cwd', async () => {
    const git = new FakeGitService()

    await expect(git.headSha(path('/repo/unknown'))).rejects.toThrow('no HEAD SHA scripted for cwd')
  })

  it('isolates scripted state per cwd', async () => {
    const git = new FakeGitService()
    git.setHeadSha(path('/repo/a'), 'aaaaaaa')
    git.setHeadSha(path('/repo/b'), 'bbbbbbb')

    expect(await git.headSha(path('/repo/a'))).toBe('aaaaaaa')
    expect(await git.headSha(path('/repo/b'))).toBe('bbbbbbb')
  })
})

describe.skip('FakeGitService.hasDiffSince', () => {
  it('returns the scripted boolean for the matching (cwd, baseline) pair', async () => {
    const git = new FakeGitService()
    git.setHasDiff(path('/repo'), 'abc1234', true)

    expect(await git.hasDiffSince(path('/repo'), 'abc1234')).toBe(true)
  })

  it('throws a loud error when the (cwd, baseline) pair is unscripted', async () => {
    const git = new FakeGitService()

    await expect(git.hasDiffSince(path('/repo'), 'abc1234')).rejects.toThrow(
      'no hasDiffSince scripted',
    )
  })

  it('isolates scripted state per baseline within one cwd', async () => {
    const git = new FakeGitService()
    git.setHasDiff(path('/repo'), 'aaa1111', true)
    git.setHasDiff(path('/repo'), 'bbb2222', false)

    expect(await git.hasDiffSince(path('/repo'), 'aaa1111')).toBe(true)
    expect(await git.hasDiffSince(path('/repo'), 'bbb2222')).toBe(false)
  })
})

describe.skip('FakeGitService.diffSinceSha', () => {
  it('returns the scripted diff text for the matching (cwd, baseline) pair', async () => {
    const git = new FakeGitService()
    git.setDiff(path('/repo'), 'abc1234', 'src/foo.ts\nsrc/bar.ts\n')

    expect(await git.diffSinceSha(path('/repo'), 'abc1234')).toBe('src/foo.ts\nsrc/bar.ts\n')
  })

  it('throws a loud error when the (cwd, baseline) pair is unscripted', async () => {
    const git = new FakeGitService()

    await expect(git.diffSinceSha(path('/repo'), 'abc1234')).rejects.toThrow(
      'no diffSinceSha scripted',
    )
  })
})

describe.skip('FakeGitService.isClean', () => {
  it('returns the scripted boolean for the matching cwd', async () => {
    const git = new FakeGitService()
    git.setIsClean(path('/repo'), true)

    expect(await git.isClean(path('/repo'))).toBe(true)
  })

  it('returns false when scripted as dirty', async () => {
    const git = new FakeGitService()
    git.setIsClean(path('/repo'), false)

    expect(await git.isClean(path('/repo'))).toBe(false)
  })

  it('throws a loud error when no isClean is scripted for the cwd', async () => {
    const git = new FakeGitService()

    await expect(git.isClean(path('/repo/unknown'))).rejects.toThrow('no isClean scripted')
  })
})

describe.skip('FakeGitService.stageAll', () => {
  it('is a no-op that resolves without error', async () => {
    const git = new FakeGitService()

    await git.stageAll(path('/repo'))
  })
})

describe.skip('FakeGitService.commit', () => {
  it('returns the scripted SHA for the matching cwd', async () => {
    const git = new FakeGitService()
    git.setCommitSha(path('/repo'), 'deadbeef1234')

    const sha = await git.commit(path('/repo'), 'some message')

    expect(sha).toBe('deadbeef1234')
  })

  it('throws a loud error when no commit SHA is scripted for the cwd', async () => {
    const git = new FakeGitService()

    await expect(git.commit(path('/repo'), 'msg')).rejects.toThrow('no commit SHA scripted')
  })
})

describe.skip('FakeGitService.repoRoot', () => {
  it('returns the scripted repo root for the matching cwd', async () => {
    const git = new FakeGitService()
    git.setRepoRoot(path('/repo/sub'), path('/repo'))

    const root = await git.repoRoot(path('/repo/sub'))

    expect(root).toBe(path('/repo'))
  })

  it('throws a loud error when no repoRoot is scripted for the cwd', async () => {
    const git = new FakeGitService()

    await expect(git.repoRoot(path('/repo/unknown'))).rejects.toThrow('no repoRoot scripted')
  })

  it('isolates scripted state per cwd', async () => {
    const git = new FakeGitService()
    git.setRepoRoot(path('/a'), path('/a-root'))
    git.setRepoRoot(path('/b'), path('/b-root'))

    expect(await git.repoRoot(path('/a'))).toBe(path('/a-root'))
    expect(await git.repoRoot(path('/b'))).toBe(path('/b-root'))
  })
})

describe.skip('FakeGitService.branchExists', () => {
  it('returns the scripted boolean per (cwd, branch) pair', async () => {
    const git = new FakeGitService()
    git.setBranchExists(path('/repo'), 'feat/foo', true)
    git.setBranchExists(path('/repo'), 'feat/missing', false)

    expect(await git.branchExists(path('/repo'), 'feat/foo')).toBe(true)
    expect(await git.branchExists(path('/repo'), 'feat/missing')).toBe(false)
  })

  it('throws a loud error when the (cwd, branch) pair is unscripted', async () => {
    const git = new FakeGitService()

    await expect(git.branchExists(path('/repo'), 'feat/foo')).rejects.toThrow(
      'no branchExists scripted',
    )
  })
})

describe.skip('FakeGitService.worktreePathExists', () => {
  it('returns the scripted boolean per (cwd, path) pair', async () => {
    const git = new FakeGitService()
    git.setWorktreePathExists(path('/repo'), path('/wt/a'), true)
    git.setWorktreePathExists(path('/repo'), path('/wt/b'), false)

    expect(await git.worktreePathExists(path('/repo'), path('/wt/a'))).toBe(true)
    expect(await git.worktreePathExists(path('/repo'), path('/wt/b'))).toBe(false)
  })

  it('throws a loud error when the (cwd, path) pair is unscripted', async () => {
    const git = new FakeGitService()

    await expect(git.worktreePathExists(path('/repo'), path('/wt/a'))).rejects.toThrow(
      'no worktreePathExists scripted',
    )
  })
})

describe.skip('FakeGitService.addWorktree', () => {
  it('throws a loud error when addWorktree has not been allowed for the cwd', async () => {
    const git = new FakeGitService()

    await expect(
      git.addWorktree(path('/repo'), {
        branch: 'feat/foo',
        path: path('/wt/orch--feat-foo'),
        fromRef: 'HEAD',
      }),
    ).rejects.toThrow('addWorktree not allowed')
  })

  it('resolves to undefined and records the call when allowed', async () => {
    const git = new FakeGitService()
    git.allowAddWorktree(path('/repo'))

    const result = await git.addWorktree(path('/repo'), {
      branch: 'feat/foo',
      path: path('/wt/orch--feat-foo'),
      fromRef: 'main',
    })

    expect(result).toBeUndefined()
    expect(git.addWorktreeCalls).toEqual([
      {
        cwd: path('/repo'),
        branch: 'feat/foo',
        path: path('/wt/orch--feat-foo'),
        fromRef: 'main',
      },
    ])
  })

  it('records every call in invocation order', async () => {
    const git = new FakeGitService()
    git.allowAddWorktree(path('/repo'))

    await git.addWorktree(path('/repo'), {
      branch: 'feat/a',
      path: path('/wt/orch--feat-a'),
      fromRef: 'HEAD',
    })
    await git.addWorktree(path('/repo'), {
      branch: 'feat/b',
      path: path('/wt/orch--feat-b'),
      fromRef: 'HEAD',
    })

    expect(git.addWorktreeCalls.map((c) => c.branch)).toEqual(['feat/a', 'feat/b'])
  })
})
