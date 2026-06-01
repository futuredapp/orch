// Public barrel for the prompt-file module.
//
// Only names re-exported from `src/core/index.ts` are part of orch's user-
// facing surface: `loadPrompt`, `PromptFileError`, and the `PromptVars` type.
// The internal helpers (callerDir, resolvePromptPath, substitute,
// PromptFileReader, FakePromptFileReader, __setPromptFileReader) are reachable
// for tests via direct paths, but not re-exported here so they don't appear in
// `import * from 'orch'`.

export type { PromptFileErrorCause, PromptFileErrorDetails } from './errors.ts'
export { PromptFileError } from './errors.ts'
export { loadPrompt } from './load-prompt.ts'
export type { PromptFileRegistry } from './registry.ts'
export type { PromptVars, PromptVarsBound } from './substitute.ts'
// `PLACEHOLDER_RE` is deliberately exposed via the barrel so the codegen
// extractor (`src/codegen/extract-placeholders.ts`) imports the SAME regex
// the runtime substituter uses. Without this re-export the codegen would
// reach across module boundaries into `./substitute.ts` directly, violating
// the single-barrel rule (CLAUDE.md rule 7).
export { PLACEHOLDER_RE } from './substitute.ts'
export type {
  ExtractOptionalVars,
  ExtractRequiredVars,
  VarsOf,
} from './template-vars.ts'
