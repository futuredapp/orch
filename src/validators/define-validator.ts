import type { CheckFn } from './check.ts'
import type { Validator, ValidatorResult } from './validator.ts'

// ---------------------------------------------------------------------------
// DuplicateValidatorError — typed for test assertions
// ---------------------------------------------------------------------------

export class DuplicateValidatorError extends Error {
  readonly validatorName: string

  constructor(validatorName: string) {
    super(`Validator "${validatorName}" is already registered`)
    this.name = 'DuplicateValidatorError'
    this.validatorName = validatorName
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// Module-level registry (lazy-allocated)
// ---------------------------------------------------------------------------
//
// Lazy allocation lets tree-shakers drop the Map entirely if `defineValidator`
// is never imported. The registry is process-local: an out-of-process consumer
// (Phase 14's `orch validate` CLI) can only see validators whose defining file
// has been imported into that process.
const getRegistry: () => Map<string, Validator> = (() => {
  let r: Map<string, Validator> | null = null
  return () => {
    if (r === null) r = new Map<string, Validator>()
    return r
  }
})()

function normalizeCheckReturn(raw: unknown): ValidatorResult {
  if (raw === undefined) {
    throw new Error('defineValidator(fn) returned undefined — did you forget a return?')
  }
  if (raw === true) return { ok: true }
  if (raw === false) return { ok: false, reason: `${String(raw)}` }
  if (typeof raw === 'string') return { ok: false, reason: raw }
  return raw as ValidatorResult
}

/**
 * Registers a named validator into the module-level registry and returns
 * the Validator directly (NOT a factory — defineValidator takes no runtime
 * config, so parentheses at call sites add nothing).
 *
 * The registry exists so Phase 14's `orch validate <runId> <stepName>`
 * CLI can look up validators by stable name. JSDoc constraint: place
 * defineValidator calls in files the Stop hook CLI can import —
 * typically alongside your workflow.
 *
 * Duplicate registration throws a typed `DuplicateValidatorError` so tests
 * can assert on the class, not the message.
 */
export function defineValidator<V = unknown>(name: string, fn: CheckFn<V>): Validator<V> {
  const registry = getRegistry()
  if (registry.has(name)) {
    throw new DuplicateValidatorError(name)
  }
  const validator: Validator<V> = {
    name,
    async run(_services, ctx): Promise<ValidatorResult> {
      const raw = await fn(ctx)
      return normalizeCheckReturn(raw)
    },
  }
  registry.set(name, validator as unknown as Validator)
  return validator
}

/** Lookup a named validator. Used by Phase 14's out-of-process CLI. */
export function getValidator(name: string): Validator | undefined {
  return getRegistry().get(name)
}

/**
 * Test-only helper. Wired into an `afterEach` in define-validator.test.ts
 * so each test starts with an empty registry. Throws in production to
 * prevent accidental use — same pattern react-dom uses for test-only exports.
 *
 * NOT exported from the public barrel (`src/validators/index.ts`) — tests
 * must import directly from this file.
 */
export function __resetValidatorRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetValidatorRegistryForTests() must not be called in production')
  }
  getRegistry().clear()
}
