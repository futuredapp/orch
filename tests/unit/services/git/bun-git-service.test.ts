import { describe, expect, it } from 'bun:test'
import {
  BunGitService,
  FakeProcessService,
  GitCommandError,
  path,
} from '../../../../src/services/index.ts'

function makeGit(): { git: BunGitService; proc: FakeProcessService } {
  const proc = new FakeProcessService()
  const git = new BunGitService({ processService: proc })
  return { git, proc }
}

describe('BunGitService.headSha', () => {
  it('spawns `git rev-parse HEAD --` in the given cwd and returns stdout trimmed', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stdout: ['abc1234def5678'],
      exit: 0,
    })

    const sha = await git.headSha(path('/repo'))

    expect(sha).toBe('abc1234def5678')
  })

  it('throws GitCommandError on non-zero exit', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stdout: [],
      stderr: ['fatal: not a git repository'],
      exit: 128,
    })

    await expect(git.headSha(path('/not-a-repo'))).rejects.toThrow(GitCommandError)
  })
})

describe('BunGitService.hasDiffSince', () => {
  it('returns false when `git diff --quiet` exits 0 (clean)', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--quiet', 'abc1234', '--']).respondWith({ exit: 0 })

    expect(await git.hasDiffSince(path('/repo'), 'abc1234')).toBe(false)
  })

  it('returns true when `git diff --quiet` exits 1 (dirty)', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--quiet', 'abc1234', '--']).respondWith({ exit: 1 })

    expect(await git.hasDiffSince(path('/repo'), 'abc1234')).toBe(true)
  })

  it('throws GitCommandError on exit > 1', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'diff', '--quiet', 'abc1234', '--'])
      .respondWith({ stderr: ['fatal: bad object'], exit: 128 })

    await expect(git.hasDiffSince(path('/repo'), 'abc1234')).rejects.toThrow(GitCommandError)
  })

  it('rejects a SHA that does not match the hex pattern without spawning git', async () => {
    const { git } = makeGit()

    await expect(git.hasDiffSince(path('/repo'), '--upload-pack=/tmp/evil')).rejects.toThrow(
      'refusing unsafe SHA',
    )
  })
})

describe('BunGitService.diffSinceSha', () => {
  it('uses --name-only and returns raw stdout', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--name-only', 'abc1234', '--']).respondWith({
      stdout: ['src/foo.ts', 'src/bar.ts'],
      exit: 0,
    })

    const diff = await git.diffSinceSha(path('/repo'), 'abc1234')

    expect(diff).toContain('src/foo.ts')
    expect(diff).toContain('src/bar.ts')
  })

  it('rejects unsafe SHA arguments before spawning git', async () => {
    const { git } = makeGit()

    await expect(git.diffSinceSha(path('/repo'), '/etc/passwd')).rejects.toThrow(
      'refusing unsafe SHA',
    )
  })
})

describe('BunGitService env hardening', () => {
  it('invokes git with the argv shape documented by the port (captured per command)', async () => {
    // Sanity check: all three methods push the `--` separator so that a
    // poisoned SHA cannot be reinterpreted as a flag or a path.
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({ stdout: ['deadbeef'], exit: 0 })
    proc.when(['git', 'diff', '--quiet', 'deadbeef', '--']).respondWith({ exit: 0 })
    proc.when(['git', 'diff', '--name-only', 'deadbeef', '--']).respondWith({ stdout: [], exit: 0 })

    await git.headSha(path('/repo'))
    await git.hasDiffSince(path('/repo'), 'deadbeef')
    await git.diffSinceSha(path('/repo'), 'deadbeef')
  })
})

describe('BunGitService.redactStderr', () => {
  it('strips credential URLs from GitCommandError stderr', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stderr: ['remote: fatal: cannot fetch https://user:s3cr3t@github.com/evil/repo.git'],
      exit: 128,
    })

    try {
      await git.headSha(path('/repo'))
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError)
      const gce = err as GitCommandError
      expect(gce.stderr).not.toContain('s3cr3t')
      expect(gce.stderr).toContain('[REDACTED]')
    }
  })
})
