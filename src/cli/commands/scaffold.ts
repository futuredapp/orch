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
