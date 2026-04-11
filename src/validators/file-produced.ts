import type { Validator, ValidatorResult } from './validator.ts'

const IGNORE_SUBSTRINGS = ['/node_modules/', '/.git/']

function isIgnored(relativePath: string): boolean {
  if (relativePath.startsWith('node_modules/') || relativePath.startsWith('.git/')) return true
  return IGNORE_SUBSTRINGS.some((s) => relativePath.includes(s))
}

function assertSafeGlob(glob: string): void {
  const trimmed = glob.trim()
  if (trimmed.length === 0) {
    throw new Error('fileProduced(glob): glob must not be empty or whitespace-only')
  }
  if (trimmed.startsWith('/')) {
    throw new Error(`fileProduced(glob): absolute paths are not allowed ("${glob}")`)
  }
  if (trimmed.startsWith('~')) {
    throw new Error(`fileProduced(glob): tilde-prefixed paths are not allowed ("${glob}")`)
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '..') {
      throw new Error(
        `fileProduced(glob): parent-traversal ".." components are not allowed ("${glob}")`,
      )
    }
  }
}

/**
 * Asserts that at least one file under `ctx.cwd` matches the glob.
 *
 * Short-circuits on the first non-ignored match — this keeps globs like
 * `**\/*.ts` cheap on a monorepo. Paths under `node_modules/` and `.git/`
 * are filtered out post-iteration (Bun.Glob has no `ignore:` option).
 *
 * Note: `Bun.Glob` does NOT match dotfiles by default. `fileProduced('.env')`
 * will silently fail; Phase 6 documents the limitation and defers a
 * `dot: true` option to a later phase.
 */
export function fileProduced(glob: string): Validator {
  assertSafeGlob(glob)
  return {
    name: `fileProduced(${glob})`,
    async run(services, ctx): Promise<ValidatorResult> {
      for await (const match of services.fs.glob(glob, { cwd: ctx.cwd })) {
        if (isIgnored(match)) continue
        return { ok: true }
      }
      return {
        ok: false,
        reason: `No files matched glob "${glob}" under ${ctx.cwd}`,
        hint: `Make sure the step writes at least one file matching "${glob}".`,
      }
    },
  }
}
