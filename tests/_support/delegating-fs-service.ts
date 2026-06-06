import type { FsService, Path } from '../../src/services/index.ts'

export class DelegatingFsService<TInner extends FsService = FsService> implements FsService {
  constructor(readonly inner: TInner) {}

  readFile(p: Path): Promise<string> {
    return this.inner.readFile(p)
  }

  writeFile(p: Path, data: string): Promise<void> {
    return this.inner.writeFile(p, data)
  }

  appendFile(p: Path, data: string): Promise<void> {
    return this.inner.appendFile(p, data)
  }

  rename(from: Path, to: Path): Promise<void> {
    return this.inner.rename(from, to)
  }

  mkdir(p: Path, opts?: { readonly recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(p, opts)
  }

  exists(p: Path): Promise<boolean> {
    return this.inner.exists(p)
  }

  glob(
    pattern: string,
    opts?: { readonly cwd?: Path; readonly dot?: boolean },
  ): AsyncIterable<Path> {
    return this.inner.glob(pattern, opts)
  }

  readDir(p: Path): Promise<readonly Path[]> {
    return this.inner.readDir(p)
  }

  stat(p: Path): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    return this.inner.stat(p)
  }

  remove(p: Path): Promise<void> {
    return this.inner.remove(p)
  }

  tempDir(prefix: string): Promise<Path> {
    return this.inner.tempDir(prefix)
  }

  symlink(target: Path, linkPath: Path): Promise<void> {
    return this.inner.symlink(target, linkPath)
  }
}
