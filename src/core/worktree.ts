import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { GitService, ProcessService } from '../services/index.ts'
import { GitCommandError, path as toPath } from '../services/index.ts'
import type { StepEntry } from '../state/index.ts'
import { setWorkflowCwd } from './execution-context.ts'
import type { PostCreateHook, Step, WorktreeStepConfig } from './step.ts'
import type { Path, StepName } from './types.ts'
import { stepName } from './types.ts'
import { runPostCreate } from './worktree-post-create.ts'

// ---------------------------------------------------------------------------
// WorktreeResult — the value returned by `await run(createWorktree(...))`.
// JSON-serializable so it persists in `StepEntry.value`.
// ---------------------------------------------------------------------------

export interface WorktreeResult {
  readonly path: Path
  /** The original (unsanitized) branch name passed by the caller. */
  readonly branch: string
  /** "HEAD" by default, or the user-provided ref. */
  readonly fromRef: string
}

/**
 * Runtime schema for `WorktreeResult`. Used by `onCacheHit` to validate
 * cached values loaded from `state.json` (which is untrusted at replay
 * time — could be hand-edited or written by an older orch version).
 * Branded `Path` is a string at runtime, so `z.string()` accepts it.
 */
export const WorktreeResultSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  fromRef: z.string().min(1),
})

export interface CreateWorktreeOpts {
  readonly enter: boolean
  readonly from?: string
  /** `'sibling'` (default), a relative path from the repo root, or absolute. */
  readonly target?: string
  readonly postCreate?: PostCreateHook
}

const WORKTREE_PREFIX = 'worktree:'
const MAX_STEP_NAME_LENGTH = 128
const MAX_SLUG_LENGTH = MAX_STEP_NAME_LENGTH - WORKTREE_PREFIX.length

/**
 * Slugifies a branch into a step-name-safe string.
 * Slug rules mirror src/core/commit.ts:18-22 — keep in sync.
 */
function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Creates a worktree step that materialises a git worktree at a sibling
 * (or user-specified) location and optionally switches the workflow's
 * AsyncLocalStorage-scoped cwd to it.
 *
 * `await run(createWorktree('feat/foo', { enter: true }))` produces a
 * `worktree:feat-foo` step that calls
 * `git worktree add -b feat/foo <target> HEAD`. With `enter: true`, all
 * subsequent `run()` calls inside the workflow body see the new cwd via
 * `currentCwd()`.
 *
 * Returns `{ path, branch, fromRef }`. Memoization is the only safety net
 * for replay — strict policy throws if branch or target already exist.
 *
 * **Gotchas:**
 *  - `git add .` inside the worktree stages everything (secret-staging risk).
 *  - On a fresh machine the cached path may not exist on disk; you must wipe
 *    state to recreate.
 *  - Inside `parallel()`, only the homogeneous form (`parallel(items, fn)`)
 *    is valid for `enter: true` — heterogeneous branches share the outer ALS
 *    store and would corrupt cwd silently. The hard guard in `setWorkflowCwd`
 *    throws.
 *  - The sibling target lands outside the parent repo when the parent itself
 *    is in a worktree of an outer repo — keep this in mind for nested layouts.
 */
export function createWorktree(branch: string, opts: CreateWorktreeOpts): Step<WorktreeResult> {
  validateBranch(branch)
  if (typeof opts.enter !== 'boolean') {
    throw new Error(
      `createWorktree("${branch}"): "enter" is required (true switches the workflow cwd, false keeps it)`,
    )
  }
  if (opts.from !== undefined) validateFrom(opts.from)
  if (opts.target !== undefined) validateTarget(opts.target)
  if (opts.postCreate !== undefined && Array.isArray(opts.postCreate)) {
    validateSugarLines(opts.postCreate)
  }

  const slug = slugify(branch)
  if (slug.length === 0) {
    throw new Error(
      `createWorktree() branch "${branch}" produces an empty slug — use alphanumeric characters`,
    )
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `createWorktree() branch "${branch}" sanitizes to ${slug.length} chars; max is ${MAX_SLUG_LENGTH}`,
    )
  }

  const name = stepName(`${WORKTREE_PREFIX}${slug}`)

  const config: WorktreeStepConfig = {
    kind: 'worktree' as const,
    branch,
    enter: opts.enter,
    ...(opts.from !== undefined ? { fromRef: opts.from } : {}),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.postCreate !== undefined ? { postCreate: opts.postCreate } : {}),
  }

  return Object.freeze({ name, config })
}

function validateBranch(branch: string): void {
  if (branch.length === 0) {
    throw new Error('createWorktree() branch must not be empty')
  }
  if (branch.trim().length === 0) {
    throw new Error('createWorktree() branch must not be whitespace-only')
  }
  if (branch.includes('\0')) {
    throw new Error('createWorktree() branch must not contain null bytes')
  }
  if (branch.includes('\n') || branch.includes('\r')) {
    throw new Error('createWorktree() branch must not contain newline characters')
  }
  if (branch.startsWith('-')) {
    throw new Error('createWorktree() branch must not begin with a dash (option-injection guard)')
  }
}

function validateFrom(from: string): void {
  if (from.length === 0) {
    throw new Error('createWorktree() "from" must not be empty')
  }
  // Most-specific checks first so the error message names the actual problem
  // (NUL bytes and newlines are also whitespace under /\s/).
  if (from.includes('\0')) {
    throw new Error('createWorktree() "from" must not contain null bytes')
  }
  if (from.includes('\n') || from.includes('\r')) {
    throw new Error('createWorktree() "from" must not contain newline characters')
  }
  if (/\s/.test(from)) {
    throw new Error('createWorktree() "from" must not contain whitespace')
  }
  if (from.startsWith('-')) {
    throw new Error('createWorktree() "from" must not begin with a dash (option-injection guard)')
  }
}

function validateTarget(target: string): void {
  if (target.length === 0) {
    throw new Error('createWorktree() "target" must not be empty')
  }
  if (target.includes('\0')) {
    throw new Error('createWorktree() "target" must not contain null bytes')
  }
  if (target.includes('\n') || target.includes('\r')) {
    throw new Error('createWorktree() "target" must not contain newline characters')
  }
  if (target.startsWith('-')) {
    throw new Error('createWorktree() "target" must not begin with a dash (option-injection guard)')
  }
}

function validateSugarLines(lines: ReadonlyArray<string>): void {
  for (const [idx, line] of lines.entries()) {
    if (typeof line !== 'string' || line.length === 0) {
      throw new Error(`createWorktree() postCreate[${idx}] must be a non-empty string`)
    }
  }
}

// ---------------------------------------------------------------------------
// runWorktreeStep — executor branch invoked from src/core/workflow.ts
// ---------------------------------------------------------------------------

export interface WorktreeStepDeps {
  readonly gitService: GitService
  readonly processService: ProcessService
  readonly clock: { now(): number }
}

export async function runWorktreeStep(
  deps: WorktreeStepDeps,
  config: WorktreeStepConfig,
  key: StepName,
  cwd: Path,
  overrides:
    | {
        readonly prompt?: string
        readonly extraContext?: unknown
        readonly extraPrompt?: string
      }
    | undefined,
): Promise<{ value: WorktreeResult; entry: StepEntry }> {
  rejectUnsupportedOverrides(key, overrides)

  const startedAt = deps.clock.now()
  const targetPath = await resolveTargetPath(deps.gitService, cwd, config)

  await assertNoConflict(deps.gitService, cwd, config.branch, targetPath)

  const fromRef = config.fromRef ?? 'HEAD'
  await deps.gitService.addWorktree(cwd, { branch: config.branch, path: targetPath, fromRef })

  if (config.postCreate !== undefined) {
    await runPostCreate(config.postCreate, {
      origin: cwd,
      target: targetPath,
      processService: deps.processService,
    })
  }

  if (config.enter) setWorkflowCwd(targetPath)

  const value: WorktreeResult = { path: targetPath, branch: config.branch, fromRef }

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}

function rejectUnsupportedOverrides(
  key: StepName,
  overrides:
    | { readonly prompt?: string; readonly extraContext?: unknown; readonly extraPrompt?: string }
    | undefined,
): void {
  if (overrides?.prompt !== undefined) {
    throw new Error(`Worktree step "${key}" does not accept prompt overrides`)
  }
  if (overrides?.extraContext !== undefined) {
    throw new Error(`Worktree step "${key}" does not accept extraContext overrides`)
  }
  if (overrides?.extraPrompt !== undefined) {
    throw new Error(`Worktree step "${key}" does not accept extraPrompt overrides`)
  }
}

async function resolveTargetPath(
  git: GitService,
  cwd: Path,
  config: WorktreeStepConfig,
): Promise<Path> {
  const repoRoot = await git.repoRoot(cwd)
  const projectName = basename(repoRoot)
  const slug = slugify(config.branch)
  const leaf = `${projectName}--${slug}`

  const target = config.target
  let parent: string
  if (target === undefined || target === 'sibling') {
    parent = dirname(repoRoot)
  } else if (isAbsolute(target)) {
    parent = target
  } else {
    parent = resolve(repoRoot, target)
  }
  return toPath(join(parent, leaf))
}

async function assertNoConflict(
  git: GitService,
  cwd: Path,
  branch: string,
  targetPath: Path,
): Promise<void> {
  if (await git.branchExists(cwd, branch)) {
    throw new GitCommandError(0, '', `worktree: branch "${branch}" already exists`)
  }
  if (await git.worktreePathExists(cwd, targetPath)) {
    throw new GitCommandError(0, '', `worktree: path "${targetPath}" is already registered`)
  }
}
