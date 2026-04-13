import { z } from 'zod'
import type { Path } from '../services/types.ts'
import { path } from '../services/types.ts'

// ---------------------------------------------------------------------------
// OrchestratorConfig — the shape of an orch.config.ts default export
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  readonly workflows: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// defineConfig — typed identity helper (Vite-style)
// ---------------------------------------------------------------------------

export function defineConfig(config: OrchestratorConfig): OrchestratorConfig {
  return config
}

// ---------------------------------------------------------------------------
// ConfigSchema — runtime validation for the config shape
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  workflows: z.record(z.string().min(1), z.string().min(1)),
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

export async function loadConfig(cwd: Path): Promise<OrchestratorConfig> {
  const configPath = path(`${cwd}/orch.config.ts`)

  let mod: unknown
  try {
    mod = await import(configPath)
  } catch (cause) {
    throw new ConfigLoadError(
      `Cannot load config at ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      configPath,
    )
  }

  // Safe type narrowing — no `as` cast
  const defaultExport =
    typeof mod === 'object' && mod !== null && 'default' in mod
      ? (mod as { default: unknown }).default
      : undefined

  if (defaultExport === undefined) {
    throw new ConfigLoadError(
      `Config at ${configPath} has no default export. Use: export default defineConfig({ ... })`,
      configPath,
    )
  }

  const result = ConfigSchema.safeParse(defaultExport)
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigLoadError(`Invalid config at ${configPath}: ${summary}`, configPath)
  }

  return result.data
}

// ---------------------------------------------------------------------------
// resolveWorkflow — maps a workflow name to an absolute Path
// ---------------------------------------------------------------------------
// Returns branded Path — path() rejects ".." components (traversal guard).

export function resolveWorkflow(config: OrchestratorConfig, name: string, cwd: Path): Path {
  const entry = config.workflows[name]
  if (entry === undefined) {
    const available = Object.keys(config.workflows).join(', ')
    throw new Error(`Unknown workflow "${name}". Available: ${available || '(none)'}`)
  }

  // Resolve relative paths against cwd
  const resolved = entry.startsWith('/') ? entry : `${cwd}/${entry}`
  // path() rejects ".." — this is the traversal guard
  return path(resolved)
}
