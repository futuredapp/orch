import type { Path } from '../types.ts'
import type { AddWorktreeOptions, GitService } from './git-service.ts'

interface AddWorktreeCall {
  readonly cwd: Path
  readonly branch: string
  readonly path: Path
  readonly fromRef: string
}

/**
 * In-memory scriptable GitService for unit tests.
 *
 * Per-cwd scripting lets a single fake serve multiple integration test
 * scenarios in the same process. Unscripted lookups throw loud errors —
 * silent defaults (empty SHA, empty diff) would mask test-setup mistakes
 * and make failures look like production bugs.
 *
 * Framing note: this setter-style API matches `FakeFsService`'s
 * direct-state idiom, NOT `FakeProcessService`'s fluent
 * `when(argv).respondWith(...)` builder. Git state is per-cwd key-value,
 * so setters read more naturally than argv pattern-matching.
 *
 * Storage note: (cwd, key)-shaped lookups use nested maps
 * (`Map<Path, Map<string, T>>`) instead of a flat map keyed by a
 * concatenated separator string. This avoids any in-source separator —
 * earlier versions used a literal NUL byte, which made `git diff` report
 * the file as binary.
 */
export class FakeGitService implements GitService {
  #headSha = new Map<string, string>()
  #hasDiff = new Map<Path, Map<string, boolean>>()
  #diff = new Map<Path, Map<string, string>>()
  #isClean = new Map<string, boolean>()
  #commitSha = new Map<string, string>()
  #repoRoot = new Map<string, Path>()
  #branchExists = new Map<Path, Map<string, boolean>>()
  #worktreePathExists = new Map<Path, Map<string, boolean>>()
  #addWorktreeAllowed = new Set<string>()
  #addWorktreeCalls: AddWorktreeCall[] = []

  setHeadSha(cwd: Path, sha: string): void {
    this.#headSha.set(cwd, sha)
  }

  setHasDiff(cwd: Path, baseline: string, hasDiff: boolean): void {
    let inner = this.#hasDiff.get(cwd)
    if (!inner) {
      inner = new Map<string, boolean>()
      this.#hasDiff.set(cwd, inner)
    }
    inner.set(baseline, hasDiff)
  }

  setDiff(cwd: Path, baseline: string, diff: string): void {
    let inner = this.#diff.get(cwd)
    if (!inner) {
      inner = new Map<string, string>()
      this.#diff.set(cwd, inner)
    }
    inner.set(baseline, diff)
  }

  async headSha(cwd: Path): Promise<string> {
    const sha = this.#headSha.get(cwd)
    if (sha === undefined) {
      throw new Error(`FakeGitService: no HEAD SHA scripted for cwd "${cwd}"`)
    }
    return sha
  }

  async hasDiffSince(cwd: Path, sha: string): Promise<boolean> {
    const inner = this.#hasDiff.get(cwd)
    const val = inner?.get(sha)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no hasDiffSince scripted for cwd "${cwd}" and baseline "${sha}"`,
      )
    }
    return val
  }

  async diffSinceSha(cwd: Path, sha: string): Promise<string> {
    const inner = this.#diff.get(cwd)
    const val = inner?.get(sha)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no diffSinceSha scripted for cwd "${cwd}" and baseline "${sha}"`,
      )
    }
    return val
  }

  setIsClean(cwd: Path, isClean: boolean): void {
    this.#isClean.set(cwd, isClean)
  }

  setCommitSha(cwd: Path, sha: string): void {
    this.#commitSha.set(cwd, sha)
  }

  async isClean(cwd: Path): Promise<boolean> {
    const val = this.#isClean.get(cwd)
    if (val === undefined) {
      throw new Error(`FakeGitService: no isClean scripted for cwd "${cwd}"`)
    }
    return val
  }

  // stageAll is a no-op — void return, nothing to script
  async stageAll(_cwd: Path): Promise<void> {}

  async commit(cwd: Path, _message: string): Promise<string> {
    const sha = this.#commitSha.get(cwd)
    if (sha === undefined) {
      throw new Error(`FakeGitService: no commit SHA scripted for cwd "${cwd}"`)
    }
    return sha
  }

  setRepoRoot(cwd: Path, root: Path): void {
    this.#repoRoot.set(cwd, root)
  }

  async repoRoot(cwd: Path): Promise<Path> {
    const root = this.#repoRoot.get(cwd)
    if (root === undefined) {
      throw new Error(`FakeGitService: no repoRoot scripted for cwd "${cwd}"`)
    }
    return root
  }

  setBranchExists(cwd: Path, branch: string, exists: boolean): void {
    let inner = this.#branchExists.get(cwd)
    if (!inner) {
      inner = new Map<string, boolean>()
      this.#branchExists.set(cwd, inner)
    }
    inner.set(branch, exists)
  }

  async branchExists(cwd: Path, branch: string): Promise<boolean> {
    const inner = this.#branchExists.get(cwd)
    const val = inner?.get(branch)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no branchExists scripted for cwd "${cwd}" and branch "${branch}"`,
      )
    }
    return val
  }

  setWorktreePathExists(cwd: Path, target: Path, exists: boolean): void {
    let inner = this.#worktreePathExists.get(cwd)
    if (!inner) {
      inner = new Map<string, boolean>()
      this.#worktreePathExists.set(cwd, inner)
    }
    inner.set(target, exists)
  }

  async worktreePathExists(cwd: Path, target: Path): Promise<boolean> {
    const inner = this.#worktreePathExists.get(cwd)
    const val = inner?.get(target)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no worktreePathExists scripted for cwd "${cwd}" and path "${target}"`,
      )
    }
    return val
  }

  allowAddWorktree(cwd: Path): void {
    this.#addWorktreeAllowed.add(cwd)
  }

  async addWorktree(cwd: Path, opts: AddWorktreeOptions): Promise<void> {
    if (!this.#addWorktreeAllowed.has(cwd)) {
      throw new Error(
        `FakeGitService: addWorktree not allowed for cwd "${cwd}" (call allowAddWorktree first)`,
      )
    }
    this.#addWorktreeCalls.push({
      cwd,
      branch: opts.branch,
      path: opts.path,
      fromRef: opts.fromRef,
    })
  }

  get addWorktreeCalls(): ReadonlyArray<AddWorktreeCall> {
    return this.#addWorktreeCalls
  }
}
