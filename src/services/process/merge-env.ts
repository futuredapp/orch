// ---------------------------------------------------------------------------
// mergeEnv — single source of truth for runner subprocess env composition.
// ---------------------------------------------------------------------------
//
// Three-layer precedence (lowest → highest):
//
//   1. `processEnv` — orch's `process.env`. Passed through verbatim except
//      that `undefined` values are filtered. With `noUncheckedIndexedAccess`,
//      `process.env.X` types as `string | undefined`; we shed the undefined
//      at this single boundary so downstream callers receive
//      `Record<string, string>`.
//   2. `extras`     — runner/mode-specific overrides applied between
//      processEnv and ctxEnv. Today the only entry is `{ FORCE_COLOR: '3' }`
//      for Claude interactive mode in tmux; Codex passes `{}`. Inlined at
//      the call site rather than wired through `Runner.buildCommand` —
//      abstraction with one user.
//   3. `ctxEnv`     — `BuildCommandCtx.env` from the workflow author.
//      Wins last by design: the workflow file is the user's adjustment
//      surface, including the ability to disable runner extras (e.g. set
//      `FORCE_COLOR=0` for monochrome).
//
// This is the "passthrough" contract that replaced the per-runner allowlists
// and `buildTmuxEnv` PATH/HOME/LANG filter — see
// `docs/plans/2026-04-27-feat-env-passthrough-plan.md` for the rationale.

export function mergeEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  extras: Readonly<Record<string, string>>,
  ctxEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined) env[k] = v
  }
  for (const [k, v] of Object.entries(extras)) env[k] = v
  for (const [k, v] of Object.entries(ctxEnv)) env[k] = v
  return env
}
