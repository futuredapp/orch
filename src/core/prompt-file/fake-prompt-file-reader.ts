import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { PromptFileError } from './errors.ts'
import type { PromptFileReader } from './prompt-file-reader.ts'

// FakePromptFileReader — in-memory `Map<Path, string>` fake used by unit and
// integration tests. The fake mirrors the seam exactly: `readSync` returns
// stored contents (or throws PromptFileError with cause:'read-failed' if the
// path is unknown), and `projectRoot()` returns whatever the test sets.
//
// Not exported from the prompt-file barrel — tests import it directly.

export class FakePromptFileReader implements PromptFileReader {
  private readonly files: Map<string, string>
  private readonly root: Path

  constructor(projectRoot: Path | string, files: Readonly<Record<string, string>> = {}) {
    this.root = typeof projectRoot === 'string' ? path(projectRoot) : projectRoot
    this.files = new Map(Object.entries(files))
  }

  set(p: Path | string, contents: string): void {
    this.files.set(p as string, contents)
  }

  delete(p: Path | string): void {
    this.files.delete(p as string)
  }

  readSync(p: Path): string {
    const contents = this.files.get(p)
    if (contents === undefined) {
      throw new PromptFileError(
        `failed to read prompt file "${p}": no such file in FakePromptFileReader`,
        { cause: 'read-failed', promptFile: p },
      )
    }
    return contents
  }

  projectRoot(): Path {
    return this.root
  }
}
