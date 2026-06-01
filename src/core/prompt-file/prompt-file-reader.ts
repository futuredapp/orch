import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { PromptFileError } from './errors.ts'

// PromptFileReader — the sync I/O seam for the prompt-file pipeline.
//
// `readSync(path)` returns the file contents as UTF-8 (or throws
// PromptFileError on a missing/unreadable file).
// `projectRoot()` returns the orch project root, walking up from process.cwd()
// looking for `.orch/orch.config.ts` then `orch.config.ts`. If none is found,
// falls back to process.cwd() — matches `findConfigPath` semantics from
// `src/config/index.ts` but synchronous so step.define stays sync.

export interface PromptFileReader {
  readSync(p: Path): string
  projectRoot(): Path
}

class NodeFsPromptFileReader implements PromptFileReader {
  private cachedRoot: Path | undefined

  readSync(p: Path): string {
    try {
      return readFileSync(p, 'utf8')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new PromptFileError(`failed to read prompt file "${p}": ${msg}`, {
        cause: 'read-failed',
        promptFile: p,
      })
    }
  }

  projectRoot(): Path {
    if (this.cachedRoot !== undefined) return this.cachedRoot
    this.cachedRoot = findProjectRootSync(path(process.cwd()))
    return this.cachedRoot
  }
}

// Walk up from `cwd` looking for `.orch/orch.config.ts` then `orch.config.ts`.
// First match wins. If none found, return `cwd` — matches the brainstorm's
// fallback ("default to process.cwd()").
function findProjectRootSync(cwd: Path): Path {
  let current: string = cwd
  while (true) {
    if (existsSync(`${current}/.orch/orch.config.ts`)) return path(current)
    if (existsSync(`${current}/orch.config.ts`)) return path(current)
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function existsSync(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

let activeReader: PromptFileReader = new NodeFsPromptFileReader()

export function getPromptFileReader(): PromptFileReader {
  return activeReader
}

// Test-only hook. Underscore prefix signals "do not use from public code".
// Exported from the prompt-file barrel for internal/test use, NOT re-exported
// from `src/core/index.ts` so it never leaks into the public surface.
export function __setPromptFileReader(reader: PromptFileReader | undefined): void {
  activeReader = reader ?? new NodeFsPromptFileReader()
}
