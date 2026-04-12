import type {
  PersistedValidation,
  ValidationFailure,
  ValidationOutcome,
  Validator,
  ValidatorCtx,
  ValidatorServices,
} from '../validators/index.ts'

// ---------------------------------------------------------------------------
// runValidators — serial execution, no fail-fast
// ---------------------------------------------------------------------------
//
// Serial rather than Promise.all for deterministic failure ordering and
// to avoid IO thrash on filesystem-heavy validators. All validators run
// even if earlier ones fail — the whole point is multi-failure DX.

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runValidators(
  validators: ReadonlyArray<Validator>,
  services: ValidatorServices,
  ctx: ValidatorCtx,
): Promise<ReadonlyArray<ValidationOutcome>> {
  const outcomes: ValidationOutcome[] = []
  for (const v of validators) {
    try {
      const r = await v.run(services, ctx)
      if (r.ok) {
        outcomes.push({ name: v.name, ok: true })
      } else {
        outcomes.push({
          name: v.name,
          ok: false,
          reason: r.reason,
          ...(r.hint !== undefined ? { hint: r.hint } : {}),
        })
      }
    } catch (err) {
      outcomes.push({ name: v.name, ok: false, reason: errorMessage(err) })
    }
  }
  return outcomes
}

export function outcomesToFailures(
  outcomes: ReadonlyArray<ValidationOutcome>,
): ReadonlyArray<ValidationFailure> {
  const failures: ValidationFailure[] = []
  for (const o of outcomes) {
    if (o.ok) continue
    failures.push({
      name: o.name,
      reason: o.reason,
      ...(o.hint !== undefined ? { hint: o.hint } : {}),
    })
  }
  return failures
}

export function outcomesToPersisted(
  outcomes: ReadonlyArray<ValidationOutcome>,
): ReadonlyArray<PersistedValidation> {
  return outcomes.map((o): PersistedValidation => {
    if (o.ok) return { name: o.name, ok: true }
    return {
      name: o.name,
      ok: false,
      reason: o.reason,
      ...(o.hint !== undefined ? { hint: o.hint } : {}),
    }
  })
}
