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
  glob(pattern: string, opts?: { readonly cwd?: Path }): AsyncIterable<Path>
  readDir(path: Path): Promise<readonly Path[]>
  stat(path: Path): Promise<{ readonly size: number; readonly mtimeMs: number }>
  remove(path: Path): Promise<void>
  tempDir(prefix: string): Promise<Path>
}
