import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { PromptFileError } from './errors.ts'

// resolvePromptPath — turn a `promptFile` input into an absolute Path.
//
//   - input starts with "@/" → resolve against projectRoot.
//   - else                   → resolve against callerDir.
//
// After resolution the result MUST live under projectRoot, otherwise traversal
// is rejected (R7). The `path()` smart constructor refuses any `..` component
// in the post-normalize string, which is a second line of defense.
//
// Symlink hardening: a relative path can pass the lexical `isInside` check
// while pointing — via a symlink — at a target outside the project root.
// When the resolved path exists, we canonicalise via `realpathSync` on both
// the file and the project root and re-run the inside check. Non-existent
// paths still get the lexical check (no symlink risk before the file exists);
// the read itself will fail later with a clearer error.

let cachedRealRoot: { readonly raw: Path; readonly canonical: string } | undefined

function canonicalProjectRoot(projectRoot: Path): string {
  if (cachedRealRoot !== undefined && cachedRealRoot.raw === projectRoot) {
    return cachedRealRoot.canonical
  }
  let canonical = projectRoot as string
  try {
    canonical = realpathSync(projectRoot)
  } catch {
    // Project root has to exist for any workflow to load, but fail open on
    // the realpath call rather than crashing — the lexical check still
    // protects against the obvious `..` cases.
  }
  cachedRealRoot = { raw: projectRoot, canonical }
  return canonical
}

export function resolvePromptPath(input: string, callerDir: Path, projectRoot: Path): Path {
  if (input.length === 0) {
    throw new PromptFileError('promptFile: empty path is not allowed', {
      cause: 'read-failed',
      promptFile: input,
    })
  }
  const base = input.startsWith('@/') ? projectRoot : callerDir
  const rel = input.startsWith('@/') ? input.slice(2) : input
  const resolved = resolve(base, rel)
  if (!isInside(resolved, projectRoot)) {
    throw new PromptFileError(
      `promptFile: path "${input}" resolves outside the project root "${projectRoot}" — ` +
        'remove ".." segments or use the "@/..." sentinel for project-rooted paths',
      { cause: 'traversal', promptFile: input },
    )
  }
  if (existsSync(resolved)) {
    let canonical: string
    try {
      canonical = realpathSync(resolved)
    } catch {
      // The file disappeared between existsSync and realpathSync — defer to
      // the read attempt, which will surface a clean `read-failed` error.
      return path(resolved)
    }
    const canonicalRoot = canonicalProjectRoot(projectRoot)
    if (!isInside(canonical, canonicalRoot)) {
      throw new PromptFileError(
        `promptFile: path "${input}" resolves through a symlink to "${canonical}", ` +
          `which is outside the project root "${canonicalRoot}" — ` +
          'remove the symlink or move the target inside the project',
        { cause: 'traversal', promptFile: input },
      )
    }
  }
  return path(resolved)
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(parentWithSep)
}
