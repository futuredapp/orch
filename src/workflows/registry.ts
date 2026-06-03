// ---------------------------------------------------------------------------
// Built-in workflow registry — the fixed set of packaged `orch::` workflows
// ---------------------------------------------------------------------------
// Maps a built-in name (the part after the `orch::` prefix) to the module path
// relative to this `src/workflows/` directory. The resolver
// (`resolve-builtin.ts`) anchors these against orch's own source tree so they
// load both run-from-source and when orch is installed/symlinked into a host
// project — there is no dist build.
//
// Values are fixed internal constants (never user input), so they contain no
// `..` and `path()` traversal rejection is structurally satisfied.

/**
 * Built-in name → module path, relative to `src/workflows/`. Adding a built-in
 * is a single entry here plus its entry module.
 */
export const BUILTIN_MODULE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  'work-cc': 'work-cc/index.ts',
  'work-codex': 'work-codex/index.ts',
})

/** The bare names of every packaged built-in (without the `orch::` prefix). */
export const BUILTIN_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTIN_MODULE_PATHS))
