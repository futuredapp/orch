// MIGRATED → tests-new/unit/services/git/bun-git-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
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

describe.skip('BunGitService.headSha', () => {
  it('spawns `git rev-parse HEAD --` in the given cwd and returns stdout trimmed', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stdout: ['abc1234def5678'],
      exitCode: 0,
    })

    const sha = await git.headSha(path('/repo'))

    expect(sha).toBe('abc1234def5678')
  })

  it('throws GitCommandError on non-zero exit', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stdout: [],
      stderr: ['fatal: not a git repository'],
      exitCode: 128,
    })

    await expect(git.headSha(path('/not-a-repo'))).rejects.toThrow(GitCommandError)
  })
})

describe.skip('BunGitService.hasDiffSince', () => {
  it('returns false when `git diff --quiet` exits 0 (clean)', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--quiet', 'abc1234', '--']).respondWith({ exitCode: 0 })

    expect(await git.hasDiffSince(path('/repo'), 'abc1234')).toBe(false)
  })

  it('returns true when `git diff --quiet` exits 1 (dirty)', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--quiet', 'abc1234', '--']).respondWith({ exitCode: 1 })

    expect(await git.hasDiffSince(path('/repo'), 'abc1234')).toBe(true)
  })

  it('throws GitCommandError on exit > 1', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'diff', '--quiet', 'abc1234', '--'])
      .respondWith({ stderr: ['fatal: bad object'], exitCode: 128 })

    await expect(git.hasDiffSince(path('/repo'), 'abc1234')).rejects.toThrow(GitCommandError)
  })

  it('rejects a SHA that does not match the hex pattern without spawning git', async () => {
    const { git } = makeGit()

    await expect(git.hasDiffSince(path('/repo'), '--upload-pack=/tmp/evil')).rejects.toThrow(
      'refusing unsafe SHA',
    )
  })
})

describe.skip('BunGitService.diffSinceSha', () => {
  it('uses --name-only and returns raw stdout', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'diff', '--name-only', 'abc1234', '--']).respondWith({
      stdout: ['src/foo.ts', 'src/bar.ts'],
      exitCode: 0,
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

describe.skip('BunGitService env hardening', () => {
  it('invokes git with the argv shape documented by the port (captured per command)', async () => {
    // Sanity check: all three methods push the `--` separator so that a
    // poisoned SHA cannot be reinterpreted as a flag or a path.
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({ stdout: ['deadbeef'], exitCode: 0 })
    proc.when(['git', 'diff', '--quiet', 'deadbeef', '--']).respondWith({ exitCode: 0 })
    proc
      .when(['git', 'diff', '--name-only', 'deadbeef', '--'])
      .respondWith({ stdout: [], exitCode: 0 })

    await git.headSha(path('/repo'))
    await git.hasDiffSince(path('/repo'), 'deadbeef')
    await git.diffSinceSha(path('/repo'), 'deadbeef')
  })
})

describe.skip('BunGitService.isClean', () => {
  it('returns true when git status --porcelain stdout is empty', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'status', '--porcelain']).respondWith({
      stdout: [],
      exitCode: 0,
    })

    expect(await git.isClean(path('/repo'))).toBe(true)
  })

  it('returns false for a modified file', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'status', '--porcelain']).respondWith({
      stdout: [' M src/foo.ts'],
      exitCode: 0,
    })

    expect(await git.isClean(path('/repo'))).toBe(false)
  })

  it('returns false for an untracked file', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'status', '--porcelain']).respondWith({
      stdout: ['?? new-file.ts'],
      exitCode: 0,
    })

    expect(await git.isClean(path('/repo'))).toBe(false)
  })

  it('throws GitCommandError on non-zero exit', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'status', '--porcelain']).respondWith({
      stderr: ['fatal: not a git repository'],
      exitCode: 128,
    })

    await expect(git.isClean(path('/repo'))).rejects.toThrow(GitCommandError)
  })
})

describe.skip('BunGitService.stageAll', () => {
  it('spawns git add . with correct argv and cwd', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'add', '.']).respondWith({ exitCode: 0 })

    await git.stageAll(path('/repo'))

    // If we got here without throwing, the correct argv was matched
  })

  it('throws GitCommandError when git add fails', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'add', '.']).respondWith({
      stderr: ['fatal: not a git repository'],
      exitCode: 128,
    })

    await expect(git.stageAll(path('/repo'))).rejects.toThrow(GitCommandError)
  })
})

describe.skip('BunGitService.commit', () => {
  it('spawns git commit -m then git rev-parse HEAD and returns the SHA', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'commit', '-m', 'checkpoint']).respondWith({ exitCode: 0 })
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stdout: ['abc1234def5678'],
      exitCode: 0,
    })

    const sha = await git.commit(path('/repo'), 'checkpoint')

    expect(sha).toBe('abc1234def5678')
  })

  it('throws GitCommandError when git commit fails', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'commit', '-m', 'bad']).respondWith({
      stderr: ['nothing to commit'],
      exitCode: 1,
    })

    await expect(git.commit(path('/repo'), 'bad')).rejects.toThrow(GitCommandError)
  })

  it('propagates GitCommandError when rev-parse HEAD fails after successful commit', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'commit', '-m', 'ok']).respondWith({ exitCode: 0 })
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stderr: ['fatal: ambiguous argument'],
      exitCode: 128,
    })

    await expect(git.commit(path('/repo'), 'ok')).rejects.toThrow(GitCommandError)
  })
})

describe.skip('BunGitService.redactStderr', () => {
  it('strips credential URLs from GitCommandError stderr', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', 'HEAD']).respondWith({
      stderr: ['remote: fatal: cannot fetch https://user:s3cr3t@github.com/evil/repo.git'],
      exitCode: 128,
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

describe.skip('BunGitService.repoRoot', () => {
  it('returns the absolute path from git rev-parse --show-toplevel', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', '--show-toplevel']).respondWith({
      stdout: ['/home/me/projects/orch'],
      exitCode: 0,
    })

    const root = await git.repoRoot(path('/home/me/projects/orch/sub'))

    expect(root).toBe(path('/home/me/projects/orch'))
  })

  it('throws GitCommandError when git rev-parse --show-toplevel fails', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', '--show-toplevel']).respondWith({
      stdout: [],
      stderr: ['fatal: not a git repository'],
      exitCode: 128,
    })

    await expect(git.repoRoot(path('/not-a-repo'))).rejects.toThrow(GitCommandError)
  })

  it('redacts $HOME paths in repoRoot stderr before throwing', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'rev-parse', '--show-toplevel']).respondWith({
      stderr: [`fatal: not a git repository: ${process.env.HOME ?? ''}/secret`],
      exitCode: 128,
    })

    if (!process.env.HOME) return

    try {
      await git.repoRoot(path('/whatever'))
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError)
      const gce = err as GitCommandError
      expect(gce.stderr).not.toContain(process.env.HOME)
      expect(gce.stderr).toContain('~')
    }
  })
})

describe.skip('BunGitService.branchExists', () => {
  it('returns true when git show-ref --verify --quiet exits 0', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/feat/foo'])
      .respondWith({ exitCode: 0 })

    expect(await git.branchExists(path('/repo'), 'feat/foo')).toBe(true)
  })

  it('returns false when git show-ref --verify --quiet exits 1', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/feat/missing'])
      .respondWith({ exitCode: 1 })

    expect(await git.branchExists(path('/repo'), 'feat/missing')).toBe(false)
  })

  it('throws GitCommandError when git show-ref exits with code >= 2', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/bad'])
      .respondWith({ stderr: ['fatal: bad ref'], exitCode: 128 })

    await expect(git.branchExists(path('/repo'), 'bad')).rejects.toThrow(GitCommandError)
  })
})

describe.skip('BunGitService.worktreePathExists', () => {
  it('returns true when the path appears as a worktree line in --porcelain output', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'worktree', 'list', '--porcelain']).respondWith({
      stdout: [
        'worktree /home/me/projects/orch',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /home/me/projects/orch--feat-foo',
        'HEAD def456',
        'branch refs/heads/feat/foo',
      ],
      exitCode: 0,
    })

    expect(
      await git.worktreePathExists(path('/repo'), path('/home/me/projects/orch--feat-foo')),
    ).toBe(true)
  })

  it('returns false when the path is absent from --porcelain output', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'worktree', 'list', '--porcelain']).respondWith({
      stdout: ['worktree /home/me/projects/orch', 'HEAD abc123', 'branch refs/heads/main'],
      exitCode: 0,
    })

    expect(
      await git.worktreePathExists(path('/repo'), path('/home/me/projects/orch--missing')),
    ).toBe(false)
  })

  it('does not match a partial path prefix as a worktree entry', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'worktree', 'list', '--porcelain']).respondWith({
      stdout: ['worktree /home/me/projects/orch--feat-foobar'],
      exitCode: 0,
    })

    expect(
      await git.worktreePathExists(path('/repo'), path('/home/me/projects/orch--feat-foo')),
    ).toBe(false)
  })

  it('throws GitCommandError when git worktree list fails', async () => {
    const { git, proc } = makeGit()
    proc.when(['git', 'worktree', 'list', '--porcelain']).respondWith({
      stderr: ['fatal: not a git repository'],
      exitCode: 128,
    })

    await expect(git.worktreePathExists(path('/not-a-repo'), path('/whatever'))).rejects.toThrow(
      GitCommandError,
    )
  })
})

describe.skip('BunGitService.addWorktree', () => {
  it('spawns git worktree add -b <branch> -- <path> <fromRef> and resolves to undefined', async () => {
    const { git, proc } = makeGit()
    proc
      .when([
        'git',
        'worktree',
        'add',
        '-b',
        'feat/foo',
        '--',
        '/home/me/projects/orch--feat-foo',
        'HEAD',
      ])
      .respondWith({ exitCode: 0 })

    const result = await git.addWorktree(path('/repo'), {
      branch: 'feat/foo',
      path: path('/home/me/projects/orch--feat-foo'),
      fromRef: 'HEAD',
    })

    expect(result).toBeUndefined()
  })

  it('passes the user-provided fromRef through to git', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'worktree', 'add', '-b', 'feat/foo', '--', '/wt/orch--feat-foo', 'main'])
      .respondWith({ exitCode: 0 })

    await git.addWorktree(path('/repo'), {
      branch: 'feat/foo',
      path: path('/wt/orch--feat-foo'),
      fromRef: 'main',
    })
  })

  it('addWorktree includes "--" separator before path and fromRef', async () => {
    // Defense-in-depth: even if a future caller bypasses the factory, the
    // adapter inserts the standard end-of-options separator so positional
    // args cannot be reinterpreted as flags. FakeProcessService matches argv
    // by deep equality — if the spawn omitted "--" the call would throw
    // "no scripted response for argv".
    const { git, proc } = makeGit()
    proc
      .when(['git', 'worktree', 'add', '-b', 'feat/foo', '--', '/wt/orch--feat-foo', 'HEAD'])
      .respondWith({ exitCode: 0 })

    // Adversarial control: register the WITHOUT-separator argv as exit-128 so
    // a regression that drops the separator is caught loudly rather than
    // surfacing as the same "no scripted response" error.
    proc
      .when(['git', 'worktree', 'add', '-b', 'feat/foo', '/wt/orch--feat-foo', 'HEAD'])
      .respondWith({
        stderr: ['regression: addWorktree must use "--" separator'],
        exitCode: 128,
      })

    await git.addWorktree(path('/repo'), {
      branch: 'feat/foo',
      path: path('/wt/orch--feat-foo'),
      fromRef: 'HEAD',
    })
  })

  it('throws GitCommandError with redacted stderr when git worktree add fails', async () => {
    const { git, proc } = makeGit()
    proc
      .when(['git', 'worktree', 'add', '-b', 'feat/foo', '--', '/wt/orch--feat-foo', 'HEAD'])
      .respondWith({
        stderr: ['fatal: cannot fetch https://user:s3cr3t@github.com/evil/repo.git'],
        exitCode: 128,
      })

    try {
      await git.addWorktree(path('/repo'), {
        branch: 'feat/foo',
        path: path('/wt/orch--feat-foo'),
        fromRef: 'HEAD',
      })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError)
      const gce = err as GitCommandError
      expect(gce.stderr).not.toContain('s3cr3t')
      expect(gce.stderr).toContain('[REDACTED]')
    }
  })
})
