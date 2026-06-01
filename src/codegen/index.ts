// Public barrel for the sidecar-codegen subsystem. Consumed by the
// `orch types` CLI command and by `orch run`'s startup pre-pass.

export type { CodegenError, CodegenResult } from './codegen-result.ts'
export { discoverPrompts, expandBraces } from './discover-prompts.ts'
export { emitSidecar, type SidecarOutput } from './emit-sidecar.ts'
export { type ExtractedVars, extractPlaceholders } from './extract-placeholders.ts'
export { type RunCodegenOptions, runCodegen } from './run-codegen.ts'
