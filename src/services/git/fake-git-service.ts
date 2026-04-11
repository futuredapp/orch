import type { Path } from '../types.ts'
import type { GitService } from './git-service.ts'

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
 */
export class FakeGitService implements GitService {
  #headSha = new Map<string, string>()
  #hasDiff = new Map<string, boolean>()
  #diff = new Map<string, string>()

  setHeadSha(cwd: Path, sha: string): void {
    this.#headSha.set(cwd, sha)
  }

  setHasDiff(cwd: Path, baseline: string, hasDiff: boolean): void {
    this.#hasDiff.set(this.#diffKey(cwd, baseline), hasDiff)
  }

  setDiff(cwd: Path, baseline: string, diff: string): void {
    this.#diff.set(this.#diffKey(cwd, baseline), diff)
  }

  async headSha(cwd: Path): Promise<string> {
    const sha = this.#headSha.get(cwd)
    if (sha === undefined) {
      throw new Error(`FakeGitService: no HEAD SHA scripted for cwd "${cwd}"`)
    }
    return sha
  }

  async hasDiffSince(cwd: Path, sha: string): Promise<boolean> {
    const key = this.#diffKey(cwd, sha)
    const val = this.#hasDiff.get(key)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no hasDiffSince scripted for cwd "${cwd}" and baseline "${sha}"`,
      )
    }
    return val
  }

  async diffSinceSha(cwd: Path, sha: string): Promise<string> {
    const key = this.#diffKey(cwd, sha)
    const val = this.#diff.get(key)
    if (val === undefined) {
      throw new Error(
        `FakeGitService: no diffSinceSha scripted for cwd "${cwd}" and baseline "${sha}"`,
      )
    }
    return val
  }

  #diffKey(cwd: Path, sha: string): string {
    return `${cwd}\u0000${sha}`
  }
}
