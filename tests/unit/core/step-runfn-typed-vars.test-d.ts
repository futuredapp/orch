// MIGRATED → tests-new/unit/core/step-runfn-typed-vars.test-d.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Compile-time tests for U4 — `Step<TResult, TVars>` threading through
// `step.define` overloads, `RunFn` overloads, and `RunOverrides<V>`. Each row
// is one behavior; failures land at `tsc --noEmit` time.
//
// These tests do NOT execute any runtime code — they compile-test types only.
// The `fakeRunner` and `dummyRun` declarations are existentially typed via
// `declare` so we don't have to import a real Runner implementation.

import type { Step } from '../../../src/core/step.ts'
import { step } from '../../../src/core/step.ts'
import type { InteractiveResult } from '../../../src/core/types.ts'
import type { RunFn } from '../../../src/core/workflow.ts'
import type { Runner } from '../../../src/runners/index.ts'
import type { Equal, Expect } from '../../helpers/type-assertions.ts'

// A fake Runner reference. We don't run anything — just feed it to step.define.
declare const fakeRunner: Runner
declare const run: RunFn

// ---------------------------------------------------------------------------
// (1) Legacy single-generic `Step<T>` literals still match — default TVars.
// ---------------------------------------------------------------------------

// `Step<X>` is sugar for `Step<X, Record<string, never>>`. Both forms must be
// indistinguishable to `Equal` so existing call sites in `src/` and `tests/`
// don't suddenly fail typecheck after the generic was added.
type _Step_DefaultTVars_Object = Expect<
  Equal<Step<{ a: string }>, Step<{ a: string }, Record<string, never>>>
>
type _Step_DefaultTVars_Unknown = Expect<Equal<Step<unknown>, Step<unknown, Record<string, never>>>>
type _Step_DefaultTVars_Scalar = Expect<Equal<Step<string>, Step<string, Record<string, never>>>>

// ---------------------------------------------------------------------------
// (2) Inline literal — `prompt: 'Hi {{name}}'` (NO `as const`) infers TVars.
//     This is the load-bearing ergonomics scenario: if `<const T extends
//     string>` on `define` isn't wired correctly, every "inline literal"
//     promise collapses to `string` → `Record<string, never>` silently.
// ---------------------------------------------------------------------------

const GREET = step.define('greet', { agent: fakeRunner, prompt: 'Hi {{name}}' })

type _Greet_TVars = Expect<Equal<typeof GREET, Step<unknown, { name: string | number | boolean }>>>

// Compile-time enforcement at the call site:
//   run(GREET, { vars: { name: 'world' } })          → OK
//   run(GREET, {})                                   → @ts-expect-error
//   run(GREET, { vars: { name: 'x', extra: 'y' } }) → @ts-expect-error

declare const _r1: Promise<unknown>
// Valid call — vars supplied with the correct shape.
const _OK_NameSupplied: Promise<unknown> = run(GREET, { vars: { name: 'world' } })

// Missing required key.
// @ts-expect-error — vars is required when V has required keys
const _BAD_MissingVars: typeof _r1 = run(GREET, {})

// Extra key.
// @ts-expect-error — `extra` is not declared in V
const _BAD_ExtraKey: typeof _r1 = run(GREET, { vars: { name: 'x', extra: 'y' } })

// ---------------------------------------------------------------------------
// (3) Inline literal with `as const` — same inference, explicit form.
// ---------------------------------------------------------------------------

const GREET_AS_CONST = step.define('greet2', {
  agent: fakeRunner,
  prompt: 'Hi {{name}}' as const,
})

type _GreetAsConst_TVars = Expect<
  Equal<typeof GREET_AS_CONST, Step<unknown, { name: string | number | boolean }>>
>

// ---------------------------------------------------------------------------
// (4) Optional placeholder — `{{name?}}` infers an optional key.
// ---------------------------------------------------------------------------

const OPT = step.define('opt', { agent: fakeRunner, prompt: 'Hi {{name?}}' })

type _Opt_TVars = Expect<Equal<typeof OPT, Step<unknown, { name?: string | number | boolean }>>>

// No vars at all — typechecks because the key is optional.
const _OK_NoVars: typeof _r1 = run(OPT)
// vars omitted — typechecks for the same reason.
const _OK_EmptyVars: typeof _r1 = run(OPT, {})
// vars supplied — also typechecks.
const _OK_OptSupplied: typeof _r1 = run(OPT, { vars: { name: 'world' } })

// ---------------------------------------------------------------------------
// (5) Static prompt — no vars accepted at the call site.
// ---------------------------------------------------------------------------

const STATIC_STEP = step.define('static', { agent: fakeRunner, prompt: 'no placeholders here' })

type _Static_TVars = Expect<Equal<typeof STATIC_STEP, Step<unknown, Record<string, never>>>>

// `run(STATIC_STEP)` typechecks; `run(STATIC_STEP, {})` typechecks.
const _OK_StaticBare: typeof _r1 = run(STATIC_STEP)
const _OK_StaticEmpty: typeof _r1 = run(STATIC_STEP, {})

// `run(STATIC_STEP, { vars: { x: 'y' } })` does NOT typecheck — extra key
// rejected on a no-vars step.
// @ts-expect-error — no-vars step rejects extra keys in vars
const _BAD_StaticExtra: typeof _r1 = run(STATIC_STEP, { vars: { x: 'y' } })

// ---------------------------------------------------------------------------
// (6) Mixed required + optional — both flow through.
// ---------------------------------------------------------------------------

const MIXED = step.define('mixed', { agent: fakeRunner, prompt: 'Hi {{a}} {{b?}}' })

// vars must include `a`; `b` is optional.
const _OK_MixedRequiredOnly: typeof _r1 = run(MIXED, { vars: { a: 'x' } })
const _OK_MixedBoth: typeof _r1 = run(MIXED, { vars: { a: 'x', b: 1 } })

// @ts-expect-error — missing required key `a`
const _BAD_MixedMissingRequired: typeof _r1 = run(MIXED, { vars: { b: 1 } })

// ---------------------------------------------------------------------------
// (7) Step with `returns:` schema and inline placeholders — TResult and TVars
//     both flow.
// ---------------------------------------------------------------------------

// Use the import-free shape: declare a fake SchemaWrapper return so the test
// stays type-only and doesn't depend on Zod. The shape just needs to satisfy
// the AutonomousStepInput<T>. We use a manual cast to keep the test focused.
// In real workflows the `schema()` helper provides this.

// ---------------------------------------------------------------------------
// (8) Interactive overload — `mode: 'interactive'` always yields InteractiveResult.
// ---------------------------------------------------------------------------

const INTERACTIVE = step.define('chat', {
  agent: fakeRunner,
  mode: 'interactive',
  prompt: 'Pair on {{topic}}',
})

type _Interactive_TVars = Expect<
  Equal<typeof INTERACTIVE, Step<InteractiveResult, { topic: string | number | boolean }>>
>

const _OK_InteractiveRun: Promise<InteractiveResult> = run(INTERACTIVE, {
  vars: { topic: 'auth' },
  mode: 'interactive',
})

// ---------------------------------------------------------------------------
// (9) `RunOverrides.prompt` (full replacement) — vars contract still applies
//     at compile time, but is silently ignored at runtime. The compile contract
//     stays strict so authors don't accidentally call a vars-bearing step with
//     no vars by way of `prompt:` override.
// ---------------------------------------------------------------------------

// Prompt override + vars — typechecks; runtime substitutes the replacement.
const _OK_PromptOverrideWithVars: typeof _r1 = run(GREET, {
  prompt: 'totally different',
  vars: { name: 'world' },
})

// ---------------------------------------------------------------------------
// (10) Existing `Step<TResult>` literals from schema.test.ts — default TVars
//      keeps them indistinguishable from `Step<TResult, Record<string, never>>`.
// ---------------------------------------------------------------------------

type _SchemaTestLiteral1 = Expect<
  Equal<Step<{ a: string }>, Step<{ a: string }, Record<string, never>>>
>
type _SchemaTestLiteral2 = Expect<Equal<Step<unknown>, Step<unknown, Record<string, never>>>>
type _SchemaTestLiteral3 = Expect<Equal<Step<string>, Step<string, Record<string, never>>>>

// ---------------------------------------------------------------------------
// (11) `infer T` on a two-arg generic with a default still works — guards
//      against breaking the `ask-types.test-d.ts` infer pattern.
// ---------------------------------------------------------------------------

type StepResult<S> = S extends Step<infer T, infer _V> ? T : never
type _Infer_TResult = Expect<Equal<StepResult<typeof GREET>, unknown>>

// ---------------------------------------------------------------------------
// (12) `vars:` on `step.define` is a static type error. The runtime guard
//      (assertPromptFieldsValid) still backstops non-TS callers, but at the
//      type layer the field's type is `never`, so passing any value rejects.
// ---------------------------------------------------------------------------

const _BAD_VarsOnDefineAutonomous = step.define('x', {
  agent: fakeRunner,
  prompt: 'Hi {{name}}',
  // @ts-expect-error — vars: is forbidden on step.define (move it to run(STEP, { vars }))
  vars: { name: '1' },
})

const _BAD_VarsOnDefineInteractive = step.define('y', {
  agent: fakeRunner,
  mode: 'interactive',
  prompt: 'Pair on {{topic}}',
  // @ts-expect-error — vars: is forbidden on step.define
  vars: { topic: 'auth' },
})

// Suppress unused-binding warnings — these declarations ARE the tests.
export type {
  _BAD_ExtraKey,
  _BAD_MissingVars,
  _BAD_MixedMissingRequired,
  _BAD_StaticExtra,
  _Greet_TVars,
  _GreetAsConst_TVars,
  _Infer_TResult,
  _Interactive_TVars,
  _Opt_TVars,
  _SchemaTestLiteral1,
  _SchemaTestLiteral2,
  _SchemaTestLiteral3,
  _Static_TVars,
  _Step_DefaultTVars_Object,
  _Step_DefaultTVars_Scalar,
  _Step_DefaultTVars_Unknown,
}
export {
  _BAD_VarsOnDefineAutonomous,
  _BAD_VarsOnDefineInteractive,
  _OK_EmptyVars,
  _OK_InteractiveRun,
  _OK_MixedBoth,
  _OK_MixedRequiredOnly,
  _OK_NameSupplied,
  _OK_NoVars,
  _OK_OptSupplied,
  _OK_PromptOverrideWithVars,
  _OK_StaticBare,
  _OK_StaticEmpty,
}
