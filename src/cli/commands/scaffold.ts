import type { FsService } from '../../services/fs/index.ts'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { CONFIG_TEMPLATE, HELLO_WORKFLOW_TEMPLATE, STEPS_TEMPLATE } from './init-templates.ts'

/**
 * Write the canonical `.orch/` tree: `orch.config.ts`, `steps.ts`,
 * `workflows/hello.ts`, and an empty `state/` directory. The caller is
 * responsible for ensuring `orchDir` is the right absolute path; this
 * function does not check `cwd` or refuse self-targets.
 */
export async function writeOrchTree(fs: FsService, orchDir: Path): Promise<void> {
  await fs.mkdir(orchDir, { recursive: true })
  await fs.mkdir(path(`${orchDir}/workflows`), { recursive: true })
  await fs.mkdir(path(`${orchDir}/state`), { recursive: true })
  await fs.writeFile(path(`${orchDir}/orch.config.ts`), CONFIG_TEMPLATE)
  await fs.writeFile(path(`${orchDir}/steps.ts`), STEPS_TEMPLATE)
  await fs.writeFile(path(`${orchDir}/workflows/hello.ts`), HELLO_WORKFLOW_TEMPLATE)
}

/**
 * Idempotently append a single line (e.g. `.orch/state/`) to a `.gitignore`.
 * If the file does not exist, create it containing exactly that line plus a
 * trailing newline. If it exists and already contains the line (trimmed
 * match), do nothing. Otherwise append, inserting a leading newline only
 * when the existing file is non-empty and does not already end with one.
 */
export async function ensureGitignoreLine(
  fs: FsService,
  gitignorePath: Path,
  line: string,
): Promise<void> {
  const exists = await fs.exists(gitignorePath)
  if (!exists) {
    await fs.writeFile(gitignorePath, `${line}\n`)
    return
  }
  const current = await fs.readFile(gitignorePath)
  const present = current.split('\n').some((entry) => entry.trim() === line)
  if (present) return
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  await fs.writeFile(gitignorePath, `${current}${separator}${line}\n`)
}

/**
 * Remove an `.orch/` directory and all its contents. Sanity-rejects paths
 * that don't end with `/.orch` so an accidental wider path can't smuggle
 * through. `BunFsService.remove` is the actual recursive deleter.
 */
export async function removeOrchTree(fs: FsService, orchDir: Path): Promise<void> {
  if (!orchDir.endsWith('/.orch')) {
    throw new Error(
      `removeOrchTree: refusing to remove ${orchDir} — only paths ending in /.orch are allowed`,
    )
  }
  await fs.remove(orchDir)
}

/**
 * Enumerate user workflow files (every `.ts` under `<orchDir>/workflows/`
 * except `hello.ts`). Used by F2 "keep mode" to know which workflows to
 * leave untouched while the scaffolded files get rewritten.
 *
 * Returns an empty list when `workflows/` does not exist.
 */
export async function preservingReinitFiles(
  fs: FsService,
  orchDir: Path,
): Promise<{ readonly preservedWorkflows: ReadonlyArray<Path> }> {
  const workflowsDir = path(`${orchDir}/workflows`)
  if (!(await fs.exists(workflowsDir))) return { preservedWorkflows: [] }
  const entries = await fs.readDir(workflowsDir)
  const preserved: Path[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue
    if (entry === 'hello.ts') continue
    preserved.push(path(`${workflowsDir}/${entry}`))
  }
  return { preservedWorkflows: preserved }
}

/**
 * Scan user-authored files under `<orchDir>/` for direct `from 'zod'` (or
 * `"zod"`) imports. Returns the paths that contain such an import so the
 * caller can warn the user — workflows authored against orch's public API
 * should `import { z } from 'orch'` instead, which works without adding zod
 * to the host project's package.json.
 *
 * We check `<orchDir>/steps.ts` and every `.ts` file directly under
 * `<orchDir>/workflows/`. We ignore single-line `//` comments to avoid
 * false positives on commented-out imports. We do NOT try to parse the
 * TypeScript — `from 'zod'` / `from "zod"` substring after comment-strip
 * is enough.
 */
export async function findDirectZodImports(fs: FsService, orchDir: Path): Promise<readonly Path[]> {
  const candidates: Path[] = []
  const stepsPath = path(`${orchDir}/steps.ts`)
  if (await fs.exists(stepsPath)) candidates.push(stepsPath)
  const workflowsDir = path(`${orchDir}/workflows`)
  if (await fs.exists(workflowsDir)) {
    const entries = await fs.readDir(workflowsDir)
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue
      candidates.push(path(`${workflowsDir}/${entry}`))
    }
  }

  const hits: Path[] = []
  for (const file of candidates) {
    const source = await fs.readFile(file)
    if (sourceImportsZodDirectly(source)) hits.push(file)
  }
  return hits
}

/**
 * Exported for unit-testing. True when `source` contains a line that imports
 * (or re-exports) from the bare `'zod'` specifier, ignoring `//` line
 * comments.
 */
export function sourceImportsZodDirectly(source: string): boolean {
  for (const rawLine of source.split('\n')) {
    const commentIdx = rawLine.indexOf('//')
    const line = commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx)
    if (/from\s+['"]zod['"]/.test(line)) return true
    // Side-effect import: `import 'zod'` — rare, but covered for completeness.
    if (/^\s*import\s+['"]zod['"]\s*;?\s*$/.test(line)) return true
  }
  return false
}

/**
 * Insert a new workflow entry into the scaffolded `orch.config.ts`'s
 * `workflows: { ... }` block. The insertion is a focused regex+string-concat
 * over the well-known scaffolded shape — we do NOT parse arbitrary
 * TypeScript. If the regex does not match (the user reshaped the file),
 * throw a clear, actionable error.
 *
 * The new entry's indentation mirrors the existing block's indentation
 * (we use `    ` to match the two-level indent in CONFIG_TEMPLATE).
 */
export async function appendWorkflowToManifest(
  fs: FsService,
  configPath: Path,
  name: string,
  relPath: string,
): Promise<void> {
  const current = await fs.readFile(configPath)
  const match = current.match(/workflows:\s*\{([\s\S]*?)\}/)
  if (!match) {
    throw new Error(
      `Cannot insert "${name}" into ${configPath}: the workflows block in your config has been edited in a way orch new can't safely modify. Add the entry manually.`,
    )
  }
  const block = match[1] ?? ''
  const trimmedTail = block.replace(/\s+$/, '')
  // Quote the key — workflow names are kebab-case (e.g. `my-feature`), which
  // is not a valid JS identifier, so a bare key would produce a parse error.
  const newEntry = `\n    '${name}': '${relPath}',`
  // Replace the matched workflows block with the augmented version.
  const replaced = current.replace(
    /workflows:\s*\{([\s\S]*?)\}/,
    `workflows: {${trimmedTail}${newEntry}\n  }`,
  )
  await fs.writeFile(configPath, replaced)
}
