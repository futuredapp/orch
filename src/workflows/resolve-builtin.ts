import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Path, path } from '../services/types.ts'
import { BUILTIN_IMPORTS, BUILTIN_MODULE_PATHS, BUILTIN_NAMES } from './registry.ts'

// ---------------------------------------------------------------------------
// orch:: resolver — recognise the built-in prefix and locate the packaged
// module on orch's own source tree (NOT the user's cwd or config dir).
// ---------------------------------------------------------------------------

/** The namespace prefix that routes a `orch run` name to a packaged built-in. */
export const BUILTIN_PREFIX = 'orch::'

/**
 * True only when `name` is addressed to the built-in namespace (starts with
 * `orch::`). Bare names, the empty string, and names that merely contain
 * `orch::` mid-string are all false.
 */
export function isBuiltinName(name: string): boolean {
  return name.startsWith(BUILTIN_PREFIX)
}

/**
 * Resolve a `orch::<name>` to the absolute Path of its packaged entry module.
 *
 * The path is anchored to orch's source directory via
 * `fileURLToPath(import.meta.url)` — this is the load-bearing decision that
 * makes built-ins work both run-from-source (`bin: ./src/cli/main.ts`) and when
 * orch is installed/symlinked into a host project, since orch has no dist
 * build. Resolving against the user's cwd would break the installed case.
 *
 * Throws a clear error (listing the available built-ins) when the name is not a
 * known built-in, mirroring `resolveWorkflow`'s "Unknown workflow … Available:"
 * style.
 */
export function resolveBuiltin(name: string): Path {
  const bare = bareBuiltinName(name)
  // Object.hasOwn (not a bare index) so inherited prototype keys —
  // `orch::constructor`, `orch::__proto__`, `orch::toString` — fall into the
  // "unknown built-in" branch with a clear error rather than resolving to a
  // function/object and producing a raw TypeError from nodePath.join.
  const relative = Object.hasOwn(BUILTIN_MODULE_PATHS, bare)
    ? BUILTIN_MODULE_PATHS[bare]
    : undefined
  if (relative === undefined) {
    throw unknownBuiltinError(name)
  }

  const sourceDir = nodePath.dirname(fileURLToPath(import.meta.url))
  // path() rejects ".." — registry values are fixed internal constants, so
  // traversal is structurally impossible here.
  return path(nodePath.join(sourceDir, relative))
}

/**
 * Import a built-in's entry module by name. Unlike `resolveBuiltin` (which
 * builds a runtime path the bundler can't see), this goes through the static
 * `BUILTIN_IMPORTS` thunks so the modules are embedded in the `--compile`
 * binary and resolve in all run modes. The loader validates the name with
 * `resolveBuiltin` first, so the unknown-name branch here is defensive.
 */
export async function importBuiltin(name: string): Promise<unknown> {
  const bare = bareBuiltinName(name)
  const load = Object.hasOwn(BUILTIN_IMPORTS, bare) ? BUILTIN_IMPORTS[bare] : undefined
  if (load === undefined) {
    throw unknownBuiltinError(name)
  }
  return load()
}

/** Strip the optional `orch::` prefix; bare names pass through unchanged. */
function bareBuiltinName(name: string): string {
  return name.startsWith(BUILTIN_PREFIX) ? name.slice(BUILTIN_PREFIX.length) : name
}

/** The shared "Unknown built-in workflow … Available: …" error. */
function unknownBuiltinError(name: string): Error {
  const available = BUILTIN_NAMES.map((n) => `${BUILTIN_PREFIX}${n}`).join(', ')
  return new Error(`Unknown built-in workflow "${name}". Available: ${available || '(none)'}`)
}
