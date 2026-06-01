import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { Path } from '../types.ts'
import { path } from '../types.ts'
import type { FsService } from './fs-service.ts'

/**
 * Paths that `remove()` must never touch, no matter what the caller asks.
 * Keyed off the resolved absolute path so that symlinks and `.` segments
 * cannot smuggle a value through. `$HOME` and its direct parent are included
 * because `rm -rf $HOME` and `rm -rf /Users` would both be catastrophic.
 */
const isProtectedRoot = (resolved: string, home: string): boolean => {
  if (resolved === '' || resolved === '/') return true
  if (home !== '' && resolved === home) return true
  // Direct parent of $HOME — e.g. /Users on macOS, /home on Linux.
  if (home !== '' && resolved === nodePath.dirname(home)) return true
  return false
}

export class BunFsService implements FsService {
  readonly #homedir: () => string

  /**
   * `homedir` is injectable so unit tests can exercise the `remove()` guard
   * against deterministic values without touching the real user's home.
   * Production callers pass nothing and get `os.homedir()`.
   */
  constructor(deps: { readonly homedir?: () => string } = {}) {
    this.#homedir = deps.homedir ?? (() => os.homedir())
  }

  async readFile(p: Path): Promise<string> {
    return Bun.file(p).text()
  }

  async writeFile(p: Path, data: string): Promise<void> {
    await Bun.write(p, data)
  }

  async appendFile(p: Path, data: string): Promise<void> {
    await fs.appendFile(p, data)
  }

  async rename(from: Path, to: Path): Promise<void> {
    await fs.rename(from, to)
  }

  async mkdir(p: Path, opts?: { readonly recursive?: boolean }): Promise<void> {
    await fs.mkdir(p, { recursive: opts?.recursive ?? false })
  }

  async exists(p: Path): Promise<boolean> {
    return fs.stat(p).then(
      () => true,
      () => false,
    )
  }

  async *glob(
    pattern: string,
    opts?: { readonly cwd?: Path; readonly dot?: boolean },
  ): AsyncIterable<Path> {
    const cwd = opts?.cwd ?? path(process.cwd())
    const scanner = new Bun.Glob(pattern).scan({ cwd, dot: opts?.dot ?? false })
    for await (const match of scanner) {
      yield path(match)
    }
  }

  async readDir(p: Path): Promise<readonly Path[]> {
    const entries = await fs.readdir(p)
    return entries.map((e) => path(e))
  }

  async stat(p: Path): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    const s = await fs.stat(p)
    return { size: s.size, mtimeMs: s.mtimeMs }
  }

  async remove(p: Path): Promise<void> {
    const resolved = nodePath.resolve(p)
    const home = this.#homedir()
    if (isProtectedRoot(resolved, home)) {
      throw new Error(`remove() refused: path is a protected root (${resolved})`)
    }
    // `recursive: true, force: true` stays — the safeguard is the guard above.
    await fs.rm(p, { recursive: true, force: true })
  }

  async tempDir(prefix: string): Promise<Path> {
    return path(await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix)))
  }

  async symlink(target: Path, linkPath: Path): Promise<void> {
    await fs.symlink(target, linkPath)
  }
}
