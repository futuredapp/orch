// ---------------------------------------------------------------------------
// Retry/continue instruction seam (D7, KTD-4).
// ---------------------------------------------------------------------------
//
// The single source of truth for the short instruction handed to a re-run of a
// failed step. Two conceptually-distinct kinds (D7 names both):
//
//   - 'retry'    — re-run the failed step in place ([r] / autonomous recovery).
//   - 'continue' — re-run the failed step, then proceed forward ([c] / orch retry).
//
// Both fall back to the SAME built-in default ('continue') until a config
// schema exists — that schema is the sibling feature's call (brainstorm
// Non-goals), so this module deliberately ships only the default plus the
// `resolve(kind, configured?)` shape the sibling can later point its schema at
// WITHOUT re-threading the seam. The interactive typed-override input UI is
// likewise sibling-owned and is NOT built here.

/** The two instruction kinds a manual/auto re-run can resolve. */
export type InstructionKind = 'retry' | 'continue'

/** The built-in instruction used for both kinds when nothing is configured. */
export const DEFAULT_RECOVERY_INSTRUCTION = 'continue'

/** Per-kind configured overrides. Absent kinds fall back to the default. */
export type ConfiguredInstructions = Partial<Record<InstructionKind, string>>

/**
 * Resolve the instruction for `kind`: the configured value when present, else
 * the built-in default. Retry and continue can resolve to DIFFERENT strings
 * (the sibling supplies distinct values later); until then both default to
 * `'continue'`.
 */
export function resolveInstruction(
  kind: InstructionKind,
  configured?: ConfiguredInstructions,
): string {
  return configured?.[kind] ?? DEFAULT_RECOVERY_INSTRUCTION
}

/**
 * A bound resolver: `kind → instruction`. The executor threads one of these
 * through `WorkflowDeps.instructionResolver` so the manual-retry path can
 * inject configured instructions; the autonomous path uses the default
 * resolver and so still sends `'continue'` (no behavior change).
 */
export type InstructionResolver = (kind: InstructionKind) => string

/** The default resolver — `'continue'` for both kinds. */
export const defaultInstructionResolver: InstructionResolver = (kind) => resolveInstruction(kind)
