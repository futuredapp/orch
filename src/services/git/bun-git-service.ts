import type { ProcessService } from '../process/index.ts'
import type { Path } from '../types.ts'
import { GitCommandError, type GitService } from './git-service.ts'

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/**
 * Minimal env passed to every git subprocess.
 *
 * Rationale (security-hardened, never inherit full process env):
 *  - `PATH`       — needed to find the git binary itself.
 *  - `HOME`       — required for $HOME/.gitconfig and credential helpers.
 *  - `LANG`/`LC_ALL=C` — deterministic, parse-stable output.
 *  - `GIT_TERMINAL_PROMPT=0` — never hang CI on a credential prompt.
 *  - `GIT_OPTIONAL_LOCKS=0` — no lock contention with a user's concurrent git.
 *  - `GIT_CONFIG_NOSYSTEM=1` — ignore /etc/gitconfig (deterministic config).
 *
 * `GIT_DIR` and `GIT_WORK_TREE` are explicitly NOT forwarded — a poisoned
 * parent env could otherwise redirect git at an unrelated repo.
 */
const buildGitEnv = (): Readonly<Record<string, string>> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  LANG: process.env.LANG ?? 'C',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
})

const MAX_STDERR_LEN = 500

/**
 * Redacts credential URLs and absolute $HOME paths from git stderr before
 * it crosses a boundary (into `GitCommandError` → `ValidationFailure.reason`
 * → persisted state.json). The raw stderr never leaves `BunGitService`.
 */
const redactStderr = (stderr: string): string => {
  let out = stderr.replace(/https?:\/\/[^@\s/]+@/g, 'https://[REDACTED]@')
  const home = process.env.HOME ?? ''
  if (home.length > 0) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'g'), '~')
  }
  if (out.length > MAX_STDERR_LEN) {
    out = `${out.slice(0, MAX_STDERR_LEN)}…`
  }
  return out
}

const assertValidSha = (sha: string): void => {
  if (!SHA_PATTERN.test(sha)) {
    throw new GitCommandError(-1, '', `BunGitService: refusing unsafe SHA argument "${sha}"`)
  }
}

export class BunGitService implements GitService {
  readonly #processService: ProcessService

  constructor(deps: { readonly processService: ProcessService }) {
    this.#processService = deps.processService
  }

  async headSha(cwd: Path): Promise<string> {
    // `git rev-parse` prints its arguments back out, so `HEAD --` would
    // return "<sha>\n--". The `--` separator is only meaningful for
    // commands that parse refs vs. paths — rev-parse doesn't need it.
    const { stdout, stderr, exitCode } = await this.#runGit(cwd, ['git', 'rev-parse', 'HEAD'])
    if (exitCode !== 0) {
      throw new GitCommandError(
        exitCode,
        redactStderr(stderr),
        `git rev-parse HEAD failed (exit ${exitCode}): ${redactStderr(stderr)}`,
      )
    }
    // Defensively take only the first non-empty line.
    const firstLine = stdout.split('\n').find((l) => l.trim().length > 0) ?? ''
    return firstLine.trim()
  }

  async hasDiffSince(cwd: Path, sha: string): Promise<boolean> {
    assertValidSha(sha)
    const { stderr, exitCode } = await this.#runGit(cwd, ['git', 'diff', '--quiet', sha, '--'])
    // `git diff --quiet`: 0 = clean, 1 = dirty, >1 = real error.
    if (exitCode === 0) return false
    if (exitCode === 1) return true
    throw new GitCommandError(
      exitCode,
      redactStderr(stderr),
      `git diff --quiet failed (exit ${exitCode}): ${redactStderr(stderr)}`,
    )
  }

  async diffSinceSha(cwd: Path, sha: string): Promise<string> {
    assertValidSha(sha)
    const { stdout, stderr, exitCode } = await this.#runGit(cwd, [
      'git',
      'diff',
      '--name-only',
      sha,
      '--',
    ])
    if (exitCode !== 0) {
      throw new GitCommandError(
        exitCode,
        redactStderr(stderr),
        `git diff --name-only failed (exit ${exitCode}): ${redactStderr(stderr)}`,
      )
    }
    return stdout
  }

  async #runGit(
    cwd: Path,
    argv: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
    const handle = this.#processService.spawn({ argv, cwd, env: buildGitEnv() })

    const stdoutPromise = (async () => {
      const parts: string[] = []
      for await (const line of handle.stdout) parts.push(line)
      return parts.join('\n')
    })()

    const stderrPromise = (async () => {
      const parts: string[] = []
      for await (const line of handle.stderr) parts.push(line)
      return parts.join('\n')
    })()

    const [stdout, stderr, waitResult] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      handle.wait(),
    ])
    return { stdout, stderr, exitCode: waitResult.exitCode }
  }
}
