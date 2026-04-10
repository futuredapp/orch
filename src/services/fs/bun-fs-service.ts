import type { Path } from '../types.ts'
import type { FsService } from './fs-service.ts'

export class BunFsService implements FsService {
  readFile(_path: Path): Promise<string> {
    throw new Error('not implemented')
  }

  writeFile(_path: Path, _data: string): Promise<void> {
    throw new Error('not implemented')
  }

  rename(_from: Path, _to: Path): Promise<void> {
    throw new Error('not implemented')
  }

  mkdir(_path: Path, _opts?: { readonly recursive?: boolean }): Promise<void> {
    throw new Error('not implemented')
  }

  exists(_path: Path): Promise<boolean> {
    throw new Error('not implemented')
  }

  glob(_pattern: string, _opts?: { readonly cwd?: Path }): AsyncIterable<Path> {
    throw new Error('not implemented')
  }

  readDir(_path: Path): Promise<readonly Path[]> {
    throw new Error('not implemented')
  }

  stat(_path: Path): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    throw new Error('not implemented')
  }

  remove(_path: Path): Promise<void> {
    throw new Error('not implemented')
  }

  tempDir(_prefix: string): Promise<Path> {
    throw new Error('not implemented')
  }
}
