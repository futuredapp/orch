import type { Path } from '../types.ts'

// ---------------------------------------------------------------------------
// GitService — minimal port for Phase 6 validators
// ---------------------------------------------------------------------------
//
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
  /**
   * `git status --porcelain` — empty stdout means clean tree.
   * Detects modified, staged, AND untracked files.
   */
  isClean(cwd: Path): Promise<boolean>
  /** `git add .` — stages everything; respects `.gitignore`. */
  stageAll(cwd: Path): Promise<void>
  /**
   * `git commit -m <message>` then `git rev-parse HEAD` — returns new HEAD SHA.
   *
   * **Security note:** `git add .` stages everything agents produce, including
   * potential secrets (`.env`, `*.pem`). A future phase adds denylist scan.
   */
  commit(cwd: Path, message: string): Promise<string>
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
