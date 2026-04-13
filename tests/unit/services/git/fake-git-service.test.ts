import { describe, expect, it } from 'bun:test'
import { FakeGitService, path } from '../../../../src/services/index.ts'

describe('FakeGitService.headSha', () => {
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

describe('FakeGitService.hasDiffSince', () => {
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

describe('FakeGitService.diffSinceSha', () => {
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

describe('FakeGitService.isClean', () => {
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

describe('FakeGitService.stageAll', () => {
  it('is a no-op that resolves without error', async () => {
    const git = new FakeGitService()

    await git.stageAll(path('/repo'))
  })
})

describe('FakeGitService.commit', () => {
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
