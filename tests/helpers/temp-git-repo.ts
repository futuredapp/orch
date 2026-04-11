import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { type Path, path } from '../../src/services/index.ts'

export interface TempGitRepo {
  readonly cwd: Path
  readonly seedCommit: string
  cleanup(): Promise<void>
}

/**
 * Spins up a throwaway real git repo for integration tests.
 *
 * Uses `Bun.spawn` directly — this is a test helper, not production code,
 * and project rule #1 constrains src/ only. The repo is seeded with one
 * empty commit so `git rev-parse HEAD` has something to return.
 */
export async function createTempGitRepo(): Promise<TempGitRepo> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'orch-git-test-'))

  // Deterministic identity so commits produce stable SHAs inside one run
  // and no prompt for user.name/email on a CI machine.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_AUTHOR_NAME: 'Orch Test',
    GIT_AUTHOR_EMAIL: 'orch-test@example.invalid',
    GIT_COMMITTER_NAME: 'Orch Test',
    GIT_COMMITTER_EMAIL: 'orch-test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  }

  await runGit(['git', 'init', '-q', '-b', 'main', dir], { cwd: nodePath.dirname(dir), env })
  await runGit(['git', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: dir, env })
  const seedCommit = (await runGit(['git', 'rev-parse', 'HEAD'], { cwd: dir, env })).trim()

  return {
    cwd: path(dir),
    seedCommit,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function runGit(
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<string> {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${argv.slice(1).join(' ')} failed (exit ${exitCode}): ${stderr}`)
  }
  return stdout
}
