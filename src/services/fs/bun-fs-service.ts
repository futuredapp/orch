import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { Path } from '../types.ts'
import { path } from '../types.ts'
import type { FsService } from './fs-service.ts'

export class BunFsService implements FsService {
  async readFile(p: Path): Promise<string> {
    return Bun.file(p).text()
  }

  async writeFile(p: Path, data: string): Promise<void> {
    await Bun.write(p, data)
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

  async *glob(pattern: string, opts?: { readonly cwd?: Path }): AsyncIterable<Path> {
    const cwd = opts?.cwd ?? path(process.cwd())
    const scanner = new Bun.Glob(pattern).scan({ cwd })
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
    await fs.rm(p, { recursive: true, force: true })
  }

  async tempDir(prefix: string): Promise<Path> {
    return path(await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix)))
  }
}
