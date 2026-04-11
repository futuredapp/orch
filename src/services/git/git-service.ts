import type { Path } from '../types.ts'

// ---------------------------------------------------------------------------
// GitService — minimal port for Phase 6 validators
// ---------------------------------------------------------------------------
//
// `isClean()` is intentionally omitted — Phase 6 has no consumer. Phase 10
// will grow the port with commit/branch ops when the work demands it.
export interface GitService {
  /** `git rev-parse HEAD` — returns the current commit SHA. */
  headSha(cwd: Path): Promise<string>
  /**
   * `git diff --quiet <sha> --` — O(1) memory regardless of diff size.
   * Preferred over `diffSinceSha` when you only need a boolean.
   */
  hasDiffSince(cwd: Path, sha: string): Promise<boolean>
  /** `git diff --name-only <sha> --` — raw stdout for richer consumers. */
  diffSinceSha(cwd: Path, sha: string): Promise<string>
}

// ---------------------------------------------------------------------------
// GitCommandError — thrown by GitService adapters on non-zero git exit
// ---------------------------------------------------------------------------
//
// `stderr` is REDACTED by BunGitService before this error reaches callers —
// credential URLs stripped, absolute `$HOME` collapsed to `~`, length capped.
// The un-redacted form is only available inside the adapter for debugging.
export class GitCommandError extends Error {
  readonly exitCode: number
  readonly stderr: string

  constructor(exitCode: number, stderr: string, message: string) {
    super(message)
    this.name = 'GitCommandError'
    this.exitCode = exitCode
    this.stderr = stderr
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
