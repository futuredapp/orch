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

/**
 * Built-in name → a STATIC import thunk. This is the *embed* mechanism for the
 * standalone (`bun build --compile`) binary, and is distinct on purpose from
 * `BUILTIN_MODULE_PATHS` above.
 *
 * `resolveBuiltin` joins `BUILTIN_MODULE_PATHS` onto orch's source dir at
 * runtime and `import()`s the resulting absolute path. That works
 * run-from-source and via `bun link`, but the bundler cannot trace a
 * runtime-constructed path, so the built-in modules are NOT embedded in the
 * compiled binary — the dynamic `import('/$bunfs/root/work-cc/index.ts')`
 * ENOENTs (the R-3 risk in the public-release plan, confirmed on a real
 * compiled binary). A dynamic `import()` with a STATIC string literal, by
 * contrast, IS traced and embedded. The loader (`load-workflow.ts`) imports
 * built-ins through these thunks so they resolve identically in all three
 * modes: run-from-source, `bun link`, and the standalone binary.
 *
 * MUST stay key-aligned with `BUILTIN_MODULE_PATHS` — guarded by a unit test.
 */
export const BUILTIN_IMPORTS: Readonly<Record<string, () => Promise<unknown>>> = Object.freeze({
  'work-cc': () => import('./work-cc/index.ts'),
  'work-codex': () => import('./work-codex/index.ts'),
})

/** The bare names of every packaged built-in (without the `orch::` prefix). */
export const BUILTIN_NAMES: readonly string[] = Object.freeze(Object.keys(BUILTIN_MODULE_PATHS))
