// `runCodegen` — top-level orchestration of the sidecar generator.
//
// Read source files via `FsService.readFile`, parse placeholders, render
// sidecars, and write them out — but only when the on-disk content differs
// from what we'd emit (idempotent). Errors per source file are collected
// rather than thrown so the watch loop / `orch run` pre-pass can keep going.

import { PromptFileError } from '../core/prompt-file/index.ts'
import type { FsService } from '../services/fs/index.ts'
import type { Path } from '../services/index.ts'
import { path } from '../services/index.ts'
import type { CodegenError, CodegenResult } from './codegen-result.ts'
import { discoverPrompts } from './discover-prompts.ts'
import { emitSidecar } from './emit-sidecar.ts'
import { extractPlaceholders } from './extract-placeholders.ts'

export interface RunCodegenOptions {
  /**
   * Directory containing `orch.config.ts`. Used as the cwd for glob
   * expansion AND as the project root for the `@/...` registry-key prefix.
   * Matches how `findConfigPath` / `LoadedConfig.configDir` resolve.
   */
  readonly configDir: Path
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

export async function runCodegen(
  deps: { readonly fs: FsService },
  opts: RunCodegenOptions,
): Promise<CodegenResult> {
  const written: Path[] = []
  const skipped: Path[] = []
  const errors: CodegenError[] = []

  let sources: readonly Path[]
  try {
    const raw = await discoverPrompts(deps.fs, opts.configDir, opts.include, opts.exclude)
    // Defense against codegen self-amplification: an include glob like
    // `**/*` would otherwise re-discover every generated `.md.d.ts` sidecar
    // as a "prompt source" and try to emit `.md.d.ts.d.ts` on the next pass.
    // The exact extension we emit lives in `emitSidecar`; if that ever changes
    // this filter must stay in sync.
    sources = raw.filter((p) => !p.endsWith('.d.ts'))
  } catch (cause) {
    return {
      written,
      skipped,
      errors: [
        { path: opts.configDir, message: `discoverPrompts failed: ${describeError(cause)}` },
      ],
    }
  }

  for (const source of sources) {
    try {
      const content = await deps.fs.readFile(source)
      const vars = extractPlaceholders(content)
      const sidecar = emitSidecar(source, opts.configDir, vars)
      const existing = await readIfExists(deps.fs, sidecar.targetPath)
      if (existing === sidecar.content) {
        skipped.push(source)
        continue
      }
      await ensureParentDir(deps.fs, sidecar.targetPath)
      await writeAtomic(deps.fs, sidecar.targetPath, sidecar.content)
      written.push(source)
    } catch (cause) {
      errors.push(toCodegenError(source, cause))
    }
  }

  return { written, skipped, errors }
}

// Write-tmp-then-rename so partial writes (interrupted shell, full disk) never
// leave a half-rendered sidecar that the TypeScript compiler would then
// happily consume. `FsService.rename` is atomic on POSIX, matching the state-
// store write pattern used elsewhere in orch.
async function writeAtomic(fs: FsService, target: Path, content: string): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 10)
  const tmp = path(`${target}.tmp.${process.pid}.${rand}`)
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, target)
}

async function readIfExists(fs: FsService, p: Path): Promise<string | undefined> {
  if (!(await fs.exists(p))) return undefined
  try {
    return await fs.readFile(p)
  } catch {
    return undefined
  }
}

async function ensureParentDir(fs: FsService, target: Path): Promise<void> {
  const idx = target.lastIndexOf('/')
  if (idx <= 0) return
  const parent = path(target.slice(0, idx))
  if (await fs.exists(parent)) return
  await fs.mkdir(parent, { recursive: true })
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function toCodegenError(source: Path, cause: unknown): CodegenError {
  if (cause instanceof PromptFileError) {
    // Surface the structured discriminator so JSON consumers can branch on
    // cause/missing/extra without grepping the message string.
    const out: CodegenError = {
      path: source,
      message: cause.message,
      cause: cause.cause,
    }
    return cause.missing !== undefined || cause.extra !== undefined
      ? {
          ...out,
          ...(cause.missing !== undefined ? { missing: cause.missing } : {}),
          ...(cause.extra !== undefined ? { extra: cause.extra } : {}),
        }
      : out
  }
  return { path: source, message: describeError(cause) }
}
