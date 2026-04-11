import type { StepName } from '../core/types.ts'
import type { Validator } from './validator.ts'

/**
 * The placeholder sentinel used by `check(fn)` as its `name` field until
 * the executor sees the validator and renames it to `check@<step>#<index>`.
 * Kept in this module so the executor never imports `check.ts` directly.
 */
export const ANONYMOUS_CHECK_NAME = 'check'

/**
 * Normalizes a StepConfig.validate field into a typed array. Single
 * validators are wrapped into a one-element array. Anonymous `check`
 * validators (whose name is the placeholder sentinel) are renamed in
 * declaration order to `check@<stepName>#<index>` — stable names matter
 * because they appear in ValidationError messages and persist to
 * StepEntry.validations.
 */
export function normalizeValidators(
  validate: Validator | ReadonlyArray<Validator> | undefined,
  stepName: StepName,
): ReadonlyArray<Validator> {
  if (validate === undefined) return []
  const raw = Array.isArray(validate) ? validate : [validate as Validator]

  let anonIndex = 0
  return raw.map((v): Validator => {
    if (v.name === ANONYMOUS_CHECK_NAME) {
      const renamed: Validator = {
        name: `check@${stepName}#${anonIndex}`,
        run: v.run.bind(v),
        ...(v.needs !== undefined ? { needs: v.needs } : {}),
      }
      anonIndex += 1
      return renamed
    }
    return v
  })
}

/** Returns true iff any validator in the list declares it needs a headSha baseline. */
export function anyNeedsHeadSha(validators: ReadonlyArray<Validator>): boolean {
  return validators.some((v) => v.needs?.includes('headSha') ?? false)
}
