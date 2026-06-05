/**
 * Filesystem + git matchers used by `assertFilesystem(...)` / `assertGit(...)`.
 *
 * These bypass the `LifecycleSnapshot` — they read the disk and the git CLI
 * directly. They are evaluated against the implicit current `OrchHandle` so
 * the cell shape stays:
 *
 *   await assertFilesystem(fileExistsAt(path.join(handle.workflowCwd, 'plan.md')))
 *   await assertGit(worktreeExists('feature/x'))
 *
 * Polling is delegated to `assertFilesystem` / `assertGit` (in `assertions.ts`).
 * Each matcher returns a `FilesystemMatcher` — a closure that takes the handle
 * and returns a `MatchResult`.
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { OrchHandle } from './internal/lifecycle-handle.ts'
import type { MatchResult } from './internal/snapshot.ts'

export type FilesystemMatcher = (handle: OrchHandle) => Promise<MatchResult>

export const fileExistsAt = (path: string): FilesystemMatcher => {
  return async () => {
    if (existsSync(path)) {
      return { matched: true, message: `fileExistsAt("${path}"): present` }
    }
    return { matched: false, message: `fileExistsAt("${path}"): not on disk` }
  }
}

export const fileContains = (path: string, needle: string | RegExp): FilesystemMatcher => {
  return async () => {
    if (!existsSync(path)) {
      return { matched: false, message: `fileContains("${path}"): file does not exist` }
    }
    const body = await readFile(path, 'utf-8')
    const ok = typeof needle === 'string' ? body.includes(needle) : needle.test(body)
    if (ok) {
      return { matched: true, message: `fileContains("${path}", ${formatNeedle(needle)}): matched` }
    }
    return {
      matched: false,
      message: `fileContains("${path}", ${formatNeedle(needle)}): not in body (${body.length} bytes)`,
    }
  }
}

export const runArtifactExists = (
  kind: 'session' | 'events' | 'raw-output' | 'raw-stderr' | 'formatted-ansi' | 'formatted-txt',
  stepName?: string,
): FilesystemMatcher => {
  return async (handle) => {
    const filename = ARTIFACT_FILENAMES[kind]
    if (stepName === undefined) {
      return {
        matched: false,
        message: `runArtifactExists("${kind}"): stepName is required for per-step artifacts`,
      }
    }
    // SessionLogger writes per-step artifacts under <stateDir>/logs/agents/<step>/
    // (see src/observability/file-session-logger.ts:69). Host-level files like
    // formatted_output.ansi are under <stateDir>/agents/<step>/ — those are NOT
    // covered by this matcher today; extend the kind union when needed.
    const path = nodePath.join(handle.stateDir, 'logs', 'agents', stepName, filename)
    if (existsSync(path)) {
      try {
        const s = await stat(path)
        if (s.size > 0) {
          return {
            matched: true,
            message: `runArtifactExists("${kind}", "${stepName}"): ${s.size} bytes`,
          }
        }
        return {
          matched: false,
          message: `runArtifactExists("${kind}", "${stepName}"): file empty (0 bytes)`,
        }
      } catch (e) {
        return {
          matched: false,
          message: `runArtifactExists("${kind}", "${stepName}"): stat failed (${describeErr(e)})`,
        }
      }
    }
    return {
      matched: false,
      message: `runArtifactExists("${kind}", "${stepName}"): ${path} not on disk`,
    }
  }
}

const ARTIFACT_FILENAMES: Readonly<
  Record<
    'session' | 'events' | 'raw-output' | 'raw-stderr' | 'formatted-ansi' | 'formatted-txt',
    string
  >
> = {
  session: 'session.json',
  events: 'events.ndjson',
  'raw-output': 'raw_output.ndjson',
  'raw-stderr': 'raw_stderr.log',
  'formatted-ansi': 'formatted_output.ansi',
  'formatted-txt': 'formatted_output.txt',
}

// ---------------------------------------------------------------------------
// Git matchers — shell out to git inside `handle.repoRoot`.
// ---------------------------------------------------------------------------

export const worktreeExists = (branch: string): FilesystemMatcher => {
  return async (handle) => {
    const { stdout, exitCode } = await git(handle.repoRoot, ['worktree', 'list', '--porcelain'])
    if (exitCode !== 0) {
      return {
        matched: false,
        message: `worktreeExists("${branch}"): git worktree list failed (exit=${exitCode})`,
      }
    }
    // porcelain format: blocks of `worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n`
    const branchLine = `branch refs/heads/${branch}`
    if (stdout.includes(branchLine)) {
      return { matched: true, message: `worktreeExists("${branch}"): present` }
    }
    return {
      matched: false,
      message: `worktreeExists("${branch}"): branch not in worktree list (stdout=${truncate(stdout)})`,
    }
  }
}

export const branchExists = (name: string): FilesystemMatcher => {
  return async (handle) => {
    const { exitCode } = await git(handle.repoRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${name}`,
    ])
    if (exitCode === 0) {
      return { matched: true, message: `branchExists("${name}"): present` }
    }
    return { matched: false, message: `branchExists("${name}"): not in repo` }
  }
}

export const commitExists = (branch: string, messageNeedle?: string): FilesystemMatcher => {
  return async (handle) => {
    const { stdout, exitCode } = await git(handle.repoRoot, [
      'log',
      '--format=%H %s',
      '-n',
      '20',
      branch,
      '--',
    ])
    if (exitCode !== 0) {
      return {
        matched: false,
        message: `commitExists("${branch}"): git log failed (exit=${exitCode})`,
      }
    }
    const lines = stdout.split('\n').filter((l) => l.length > 0)
    if (lines.length === 0) {
      return { matched: false, message: `commitExists("${branch}"): no commits on branch` }
    }
    if (messageNeedle === undefined) {
      return { matched: true, message: `commitExists("${branch}"): ${lines.length} commit(s)` }
    }
    const hit = lines.find((l) => l.includes(messageNeedle))
    if (hit !== undefined) {
      return {
        matched: true,
        message: `commitExists("${branch}", "${messageNeedle}"): ${hit}`,
      }
    }
    return {
      matched: false,
      message: `commitExists("${branch}", "${messageNeedle}"): no commit message contains the needle (last 20: ${truncate(lines.join(' | '))})`,
    }
  }
}

async function git(
  cwd: string,
  argv: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['git', ...argv], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { stdout, stderr, exitCode: code }
}

function formatNeedle(n: string | RegExp): string {
  return n instanceof RegExp ? n.toString() : JSON.stringify(n)
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return JSON.stringify(s)
  return `${JSON.stringify(s.slice(0, max))}… (+${s.length - max} bytes)`
}

function describeErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
