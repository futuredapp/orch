import { ANONYMOUS_CHECK_NAME } from './normalize.ts'
import type { Validator, ValidatorCtx, ValidatorResult } from './validator.ts'

export type CheckFn<V = unknown> = (
  ctx: ValidatorCtx<V>,
) => true | false | string | ValidatorResult | Promise<true | false | string | ValidatorResult>

function normalizeCheckReturn(raw: unknown): ValidatorResult {
  if (raw === undefined) {
    throw new Error('check(fn) returned undefined — did you forget a return?')
  }
  if (raw === true) return { ok: true }
  if (raw === false) return { ok: false, reason: 'check returned false' }
  if (typeof raw === 'string') return { ok: false, reason: raw }
  // Assume a full ValidatorResult — let the consumer see type errors at
  // the call site if they pass something else.
  return raw as ValidatorResult
}

/**
 * Anonymous one-shot validator. Returns a Validator with the placeholder
 * name `'check'`; `normalizeValidators` renames it to
 * `check@<stepName>#<index>` when the executor resolves `validate:`.
 *
 * The function may return:
 *   - `true`                → ok
 *   - `false`               → fail with `'check returned false'`
 *   - `string`              → fail with that reason
 *   - `{ok: true}`          → ok
 *   - `{ok: false, reason}` → fail with that reason (and optional hint)
 *
 * Returning `undefined` throws a programmer-error synchronously from the
 * validator — catches the `(ctx) => { ctx.value.foo }` no-return bug.
 *
 * Thrown exceptions are NOT caught inside `check`; they bubble to the
 * executor's try/catch, which normalizes them into a `ValidationFailure`
 * with the error message. Single catch point preserves stack traces.
 */
export function check<V = unknown>(fn: CheckFn<V>): Validator<V> {
  return {
    name: ANONYMOUS_CHECK_NAME,
    async run(_services, ctx): Promise<ValidatorResult> {
      const raw = await fn(ctx)
      return normalizeCheckReturn(raw)
    },
  }
}
