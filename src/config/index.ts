import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { RUN_MODES, type RunMode } from '../core/run-mode.ts'
import type { Path } from '../services/types.ts'
import { path } from '../services/types.ts'

// ---------------------------------------------------------------------------
// OrchestratorConfig — the shape of an orch.config.ts default export
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  readonly workflows: Readonly<Record<string, string>>
  /**
   * Optional fallback used when mode autodetection can't pick a host (e.g.
   * `CI` unset + `--mode` absent + no TTY). Accepts any `RunMode`, but
   * `single-pane` is resolved at consumption time and exits 2 with the
   * deferral message.
   */
  readonly defaultMode?: RunMode
  /**
   * Prompt-file discovery for `orch types` codegen. `include` / `exclude` are
   * glob patterns relative to the config directory. When the field is omitted
   * orch uses sensible defaults that scan the recommended on-disk layout
   * (`.orch/workflows/` and `.orch/prompts/`); see `PROMPTS_DISCOVERY_DEFAULTS`.
   */
  readonly prompts?: PromptsDiscoveryConfig
}

export interface PromptsDiscoveryConfig {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/**
 * Defaults applied when `prompts` is omitted from `orch.config.ts`. When the
 * user *does* set `prompts`, they own the full list — defaults are NOT merged
 * in. This mirrors how Vite treats `optimizeDeps.include` and how Vitest
 * treats `test.include`: explicit configuration replaces, never extends.
 */
export const PROMPTS_DISCOVERY_DEFAULTS: PromptsDiscoveryConfig = Object.freeze({
  include: Object.freeze([
    '.orch/workflows/**/*.md',
    '.orch/workflows/**/*.txt',
    '.orch/prompts/**/*.md',
    '.orch/prompts/**/*.txt',
  ]),
  exclude: Object.freeze([]),
})

// ---------------------------------------------------------------------------
// defineConfig — typed identity helper (Vite-style)
// ---------------------------------------------------------------------------

export function defineConfig(config: OrchestratorConfig): OrchestratorConfig {
  return config
}

// ---------------------------------------------------------------------------
// ConfigSchema — runtime validation for the config shape
// ---------------------------------------------------------------------------

const RunModeSchema: z.ZodType<RunMode> = z.enum(RUN_MODES)

const PromptsSchema = z.object({
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)),
})

const ConfigSchema = z.object({
  workflows: z.record(z.string().min(1), z.string().min(1)),
  defaultMode: RunModeSchema.optional(),
  prompts: PromptsSchema.optional(),
})

// ---------------------------------------------------------------------------
// ConfigLoadError — thrown when config cannot be loaded or is invalid
// ---------------------------------------------------------------------------

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    readonly configPath: Path,
  ) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

// ---------------------------------------------------------------------------
// loadConfig — dynamically imports orch.config.ts and validates shape
// ---------------------------------------------------------------------------
// Trust boundary: config files execute arbitrary code at import time, same
// model as Vite/Vitest/Tailwind. Document but do not sandbox.

/**
 * Walk up from `cwd` to `/` looking for the orch config. At each level we
 * probe two locations, in order:
 *   1. `<dir>/.orch/orch.config.ts` — recommended isolated layout (everything
 *      orch-related lives inside `.orch/`, host project root stays clean).
 *   2. `<dir>/orch.config.ts` — legacy/root-level layout, still supported.
 * The `.orch/` location wins when both exist at the same level so a project
 * mid-migration switches over the moment the new file is created.
 *
 * Mirrors how `vite.config.ts` / `tsconfig.json` resolve, so a config at the
 * repo root works regardless of which subdirectory the user invokes orch
 * from. `deps.exists` is the seam tests fake out.
 */
export async function findConfigPath(
  cwd: Path,
  deps: { readonly exists: (p: Path) => Promise<boolean> },
): Promise<Path | undefined> {
  let current = cwd
  while (true) {
    const isolated = path(`${current}/.orch/orch.config.ts`)
    if (await deps.exists(isolated)) return isolated
    const rootLevel = path(`${current}/orch.config.ts`)
    if (await deps.exists(rootLevel)) return rootLevel
    const parent = parentDir(current)
    if (parent === current) return undefined
    current = path(parent)
  }
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

async function realExists(p: Path): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

/**
 * Result of loading the orch config. `configDir` is the directory of the
 * resolved `orch.config.ts` (or `.orch/orch.config.ts`) and is the base
 * against which relative workflow paths in the config are resolved. Keeping
 * it next to `config` lets callers stay decoupled from `findConfigPath`.
 */
export interface LoadedConfig {
  readonly config: OrchestratorConfig
  readonly configPath: Path
  readonly configDir: Path
}

export async function loadConfig(cwd: Path): Promise<LoadedConfig> {
  // Discover upward so a config at the repo root works from any subdir.
  const configPath =
    (await findConfigPath(cwd, { exists: realExists })) ?? path(`${cwd}/orch.config.ts`)

  let mod: unknown
  try {
    mod = await import(configPath)
  } catch (cause) {
    throw new ConfigLoadError(
      `Cannot load config at ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      configPath,
    )
  }

  // Accept either `export const config` (preferred — biome flags default
  // exports) or `export default` (legacy fixtures and pre-existing configs).
  const exported =
    typeof mod === 'object' && mod !== null
      ? ((mod as { config?: unknown; default?: unknown }).config ??
        (mod as { default?: unknown }).default)
      : undefined

  if (exported === undefined) {
    throw new ConfigLoadError(
      `Config at ${configPath} has no export. Use: export const config = defineConfig({ ... })`,
      configPath,
    )
  }

  const result = ConfigSchema.safeParse(exported)
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigLoadError(`Invalid config at ${configPath}: ${summary}`, configPath)
  }

  return { config: result.data, configPath, configDir: path(parentDir(configPath)) }
}

// ---------------------------------------------------------------------------
// resolveWorkflow — maps a workflow name to an absolute Path
// ---------------------------------------------------------------------------
// Returns branded Path — path() rejects ".." components (traversal guard).
//
// Relative workflow entries are resolved against `baseDir`, which the CLI
// supplies as the directory containing the resolved orch.config.ts (matches
// Vite/tsconfig conventions). This keeps a config like
//   { workflows: { work: 'work.ts' } }
// pointing at the workflow next to the config regardless of where the user
// invoked orch from.

/**
 * Resolve the effective prompts discovery config: explicit user value when
 * set, otherwise the documented defaults. Centralised so every reader (CLI,
 * codegen, tests) sees the same fallback policy.
 */
export function resolvePromptsConfig(config: OrchestratorConfig): PromptsDiscoveryConfig {
  return config.prompts ?? PROMPTS_DISCOVERY_DEFAULTS
}

export function resolveWorkflow(config: OrchestratorConfig, name: string, baseDir: Path): Path {
  const entry = config.workflows[name]
  if (entry === undefined) {
    const available = Object.keys(config.workflows).join(', ')
    throw new Error(`Unknown workflow "${name}". Available: ${available || '(none)'}`)
  }

  // Resolve relative paths against the config directory
  const resolved = entry.startsWith('/') ? entry : `${baseDir}/${entry}`
  // path() rejects ".." — this is the traversal guard
  return path(resolved)
}
