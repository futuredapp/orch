import { callerDir } from './caller-dir.ts'
import { PromptFileError } from './errors.ts'
import { getPromptFileReader } from './prompt-file-reader.ts'
import { resolvePromptPath } from './resolve-prompt-path.ts'
import { assertPromptVars, type PromptVars, substitute } from './substitute.ts'

// loadPrompt(path, vars) — sync helper for prompt composition.
//
// Same semantics as `promptFile` on `step.define`, but returns the substituted
// string for inline use:
//
//   const intro = loadPrompt('intro.md', { user })
//   const ctx   = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })
//   step.define('research', { agent, prompt: `${intro}\n\n${ctx}` })
//
// Path resolution: relative paths resolve against the directory of the file
// that called `loadPrompt`; `@/...` resolves against the orch project root.
// Errors (traversal, missing file, missing/extra placeholders, unsupported
// vars types) all throw `PromptFileError` synchronously at this call site.

export function loadPrompt(input: string, vars: PromptVars = {}): string {
  assertPromptVars(vars, { promptFile: input })
  const dir = callerDir(loadPrompt)
  const reader = getPromptFileReader()
  const resolved = resolvePromptPath(input, dir, reader.projectRoot())
  const template = reader.readSync(resolved)
  if (template.trim().length === 0) {
    throw new PromptFileError(
      `loadPrompt("${input}"): file is empty — prompt templates must contain at least one non-whitespace character`,
      { cause: 'empty-prompt', promptFile: input },
    )
  }
  return substitute(template, vars, { promptFile: input })
}
