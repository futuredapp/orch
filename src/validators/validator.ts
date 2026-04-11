import type { StepName } from '../core/types.ts'
import type { FsService, GitService, Path } from '../services/index.ts'

// ---------------------------------------------------------------------------
// ValidatorResult — the shape a validator's run() returns
// ---------------------------------------------------------------------------

export type ValidatorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly hint?: string }

// ---------------------------------------------------------------------------
// ValidatorCtx — what the executor passes into each validator invocation
// ---------------------------------------------------------------------------
//
// Generic on V so Phase 7's typed `returns:` can flow through without a
// breaking change to every call site that annotated `Validator` explicitly.
export interface ValidatorCtx<V = unknown> {
  readonly stepName: StepName
  readonly cwd: Path
  readonly value: V
  readonly preRunSnapshot?: { readonly headSha: string }
}

// ---------------------------------------------------------------------------
// ValidatorServices — the fake-able seams a validator is allowed to touch
// ---------------------------------------------------------------------------

export interface ValidatorServices {
  readonly fs: FsService
  readonly git: GitService
}

// ---------------------------------------------------------------------------
// Validator — the adapter interface
// ---------------------------------------------------------------------------
//
// `needs` is a capability declaration: validators that require a pre-run
// baseline opt in with `needs: ['headSha']`. The executor uses this to skip
// `safeHeadSha` entirely on steps where no validator needs it — zero git
// subprocess calls on workflows without git validators.
export interface Validator<V = unknown> {
  readonly name: string
  readonly needs?: ReadonlyArray<'headSha'>
  run(services: ValidatorServices, ctx: ValidatorCtx<V>): Promise<ValidatorResult>
}

// ---------------------------------------------------------------------------
// ValidationFailure — the user-facing shape in ValidationError.failures
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  readonly name: string
  readonly reason: string
  readonly hint?: string
}

// ---------------------------------------------------------------------------
// PersistedValidation — the shape written to StepEntry.validations on disk
// ---------------------------------------------------------------------------
//
// Extracted as a named type so `state-store.ts` (Zod schema + TS interface)
// and the executor loop share one definition. Prevents drift.
export interface PersistedValidation {
  readonly name: string
  readonly ok: boolean
  readonly reason?: string
  readonly hint?: string
}

// ---------------------------------------------------------------------------
// ValidationOutcome — internal to the executor loop
// ---------------------------------------------------------------------------
//
// Discriminated union that pairs a validator's name with its ValidatorResult.
// Used by workflow.ts to filter down to failures in declaration order without
// losing the typed `{reason, hint}` shape.
export type ValidationOutcome =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly reason: string; readonly hint?: string }

// ---------------------------------------------------------------------------
// ValidationError — aggregate error thrown when any validator fails
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly stepName: StepName
  readonly failures: ReadonlyArray<ValidationFailure>

  constructor(stepName: StepName, failures: ReadonlyArray<ValidationFailure>) {
    super(
      `Step "${stepName}" failed validation (${failures.length}):\n` +
        failures.map((f) => `  • ${f.name}: ${f.reason}`).join('\n'),
    )
    this.name = 'ValidationError'
    this.stepName = stepName
    this.failures = failures
    // Cross-transpile instanceof safety — mirrors StepError pattern.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// ok / fail — thin helpers for explicit result construction
// ---------------------------------------------------------------------------

export const ok = (): ValidatorResult => ({ ok: true })

export const fail = (reason: string, hint?: string): ValidatorResult =>
  hint === undefined ? { ok: false, reason } : { ok: false, reason, hint }
