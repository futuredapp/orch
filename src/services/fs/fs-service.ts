import type { Path } from '../types.ts'

export interface FsService {
  readFile(path: Path): Promise<string>
  writeFile(path: Path, data: string): Promise<void>
  /** Append `data` to `path`. Creates the file if missing. Parent directory
   *  must already exist. Used by the transcript sidecar writer. */
  appendFile(path: Path, data: string): Promise<void>
  /** Atomic swap — used by Phase 3's state store write-tmp-then-rename pattern. */
  rename(from: Path, to: Path): Promise<void>
  mkdir(path: Path, opts?: { readonly recursive?: boolean }): Promise<void>
  exists(path: Path): Promise<boolean>
  /**
   * Expand `pattern` against the filesystem starting at `cwd`.
   *
   * `dot: true` causes the matcher to descend into directories whose name
   * starts with `.` (matches Bun.Glob's `dot` option). The codegen uses this
   * to discover prompt files under `.orch/...`; the default (`dot: false`)
   * preserves existing validator behavior.
   */
  glob(pattern: string, opts?: { readonly cwd?: Path; readonly dot?: boolean }): AsyncIterable<Path>
  readDir(path: Path): Promise<readonly Path[]>
  stat(path: Path): Promise<{ readonly size: number; readonly mtimeMs: number }>
  remove(path: Path): Promise<void>
  tempDir(prefix: string): Promise<Path>
  /**
   * Create a symbolic link at `linkPath` pointing to `target`. The parent
   * directory of `linkPath` must already exist. Used by the Codex auto-stop
   * strategy to build a per-run `CODEX_HOME` that inherits the real `~/.codex`
   * entries (including `auth.json`) without copying them.
   */
  symlink(target: Path, linkPath: Path): Promise<void>
}
