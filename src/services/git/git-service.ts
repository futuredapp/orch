import type { Path } from '../types.ts'

// ---------------------------------------------------------------------------
// GitService — minimal port for Phase 6 validators
// ---------------------------------------------------------------------------
//
export interface AddWorktreeOptions {
  readonly branch: string
  readonly path: Path
  readonly fromRef: string
}

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
  /**
   * `git rev-parse --show-toplevel` — absolute path of the working tree root.
   * Inside a worktree, returns the worktree's own root (not the upstream repo).
   */
  repoRoot(cwd: Path): Promise<Path>
  /**
   * `git show-ref --verify --quiet refs/heads/<branch>` —
   * exit 0 = exists, 1 = absent, ≥2 = error.
   */
  branchExists(cwd: Path, branch: string): Promise<boolean>
  /**
   * Parses `git worktree list --porcelain` for a `worktree <path>` line.
   * More robust than `fs.exists` — catches registered-but-pruned entries.
   */
  worktreePathExists(cwd: Path, path: Path): Promise<boolean>
  /** `git worktree add -b <branch> <path> <fromRef>`. */
  addWorktree(cwd: Path, opts: AddWorktreeOptions): Promise<void>
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
