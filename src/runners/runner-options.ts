// ---------------------------------------------------------------------------
// RunnerOptionsBase - the options every runner builder shares
// ---------------------------------------------------------------------------
//
// `model` and `flags` are the two fields common to `claude()` and `codex()`
// (and any future runner builder). Extracting them here lets the shared
// semantics be documented once; per-runner interfaces extend this base and add
// only their divergent fields (Claude's `maxTurns`/`bare`, Codex's `sandbox`).
// This module is runner-internal - it is NOT re-exported from the public
// `src/runners/index.ts` barrel.

export interface RunnerOptionsBase {
  readonly model?: string
  readonly flags?: readonly string[]
}
