// Discover prompt source files matching the configured globs.
//
// The discovery seam is the existing `FsService.glob()` port — BunFsService
// delegates to `Bun.Glob`, FakeFsService runs a regex matcher in memory. We
// never reach for `Bun.Glob` directly, which keeps unit tests boundary-clean
// per CLAUDE.md rule 3.

import type { FsService } from '../services/fs/index.ts'
import type { Path } from '../services/index.ts'
import { path } from '../services/index.ts'

/**
 * Return absolute paths of every file matched by `include` minus everything
 * matched by `exclude`. Results are ASCII-sorted so the output ordering of
 * downstream consumers (sidecar writes, summaries) is stable across runs.
 *
 * Brace-expansion (`*.{md,txt}`) is normalised here so the same patterns
 * work against `BunFsService` (Bun.Glob handles braces natively) and the
 * in-memory `FakeFsService` (the test fake uses a simpler regex matcher
 * that does not understand braces). Authors writing `orch.config.ts` are
 * free to use either single-extension globs or brace globs.
 */
export async function discoverPrompts(
  fs: FsService,
  configDir: Path,
  include: readonly string[],
  exclude: readonly string[],
): Promise<readonly Path[]> {
  const includeExpanded = include.flatMap(expandBraces)
  const excludeExpanded = exclude.flatMap(expandBraces)

  const matches = new Set<string>()
  for (const pattern of includeExpanded) {
    for await (const relative of fs.glob(pattern, { cwd: configDir, dot: true })) {
      matches.add(`${configDir}/${relative}`)
    }
  }

  if (excludeExpanded.length > 0) {
    const excludeMatches = new Set<string>()
    for (const pattern of excludeExpanded) {
      for await (const relative of fs.glob(pattern, { cwd: configDir, dot: true })) {
        excludeMatches.add(`${configDir}/${relative}`)
      }
    }
    for (const m of excludeMatches) matches.delete(m)
  }

  return [...matches].sort().map((p) => path(p))
}

/**
 * Expand a single brace group of the form `prefix{a,b,c}suffix` into
 * `[prefix.a.suffix, prefix.b.suffix, prefix.c.suffix]`. Recursively handles
 * multiple brace groups in one pattern. Non-brace patterns pass through.
 *
 * Intentionally minimal — no nested braces, no quoting. The use case is the
 * `*.{md,txt}` shape from the documented defaults.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = pattern.indexOf('}', open + 1)
  if (close === -1) return [pattern]

  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const options = pattern.slice(open + 1, close).split(',')

  const result: string[] = []
  for (const opt of options) {
    for (const expanded of expandBraces(`${prefix}${opt}${suffix}`)) {
      result.push(expanded)
    }
  }
  return result
}
