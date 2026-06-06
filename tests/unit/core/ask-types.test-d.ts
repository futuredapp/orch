// MIGRATED → tests-new/unit/core/ask-types.test-d.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Compile-time tests for the const-generic and discriminated-union shape of
// `ask()`. No runtime assertions — failures land at `tsc --noEmit` time.

import { type AskInput, type AskResult, ask } from '../../../src/core/ask.ts'
import type { Step } from '../../../src/core/step.ts'
import type { Equal, Expect } from '../../helpers/type-assertions.ts'

// ---------------------------------------------------------------------------
// (1) The two branches of `AskResult` narrow correctly on `cancelled`.
// ---------------------------------------------------------------------------

type Fields = { notes: { readonly placeholder: 'optional' } }
type Buttons = 'continue' | 'retry'
type R = AskResult<Fields, Buttons>

type Cancelled = Extract<R, { cancelled: true }>
type Submitted = Extract<R, { cancelled: false }>

// In the cancelled branch, `button` is unreachable.
type _CancelledHasNoButton = Expect<
  Equal<Cancelled extends { button: unknown } ? true : false, false>
>
// In the cancelled branch, `fields` is partial of the field-name union.
type _CancelledFieldsKey = Expect<Equal<keyof Cancelled['fields'], 'notes'>>
type _CancelledFieldsValue = Expect<Equal<Cancelled['fields']['notes'], string | undefined>>

// In the submitted branch, `button` is the literal union and fields are flat.
type _SubmittedButton = Expect<Equal<Submitted['button'], Buttons>>
type _SubmittedNotes = Expect<Equal<Submitted['notes'], string>>

// ---------------------------------------------------------------------------
// (2) Const-generic narrows button literals WITHOUT `as const`.
//     If this regresses, the API is meaningfully worse than advertised.
// ---------------------------------------------------------------------------

// `ask()` returns `Step<AskResult<F, B>>`. Pull the inferred B out and assert.
type StepResult<S> = S extends Step<infer T> ? T : never
type ResultOf<S> = StepResult<S>

// Plain literal array — no `as const`.
const NO_AS_CONST = ask({
  name: 'continue',
  question: 'go?',
  buttons: ['continue', 'retry'],
})
type SubmittedNoAsConst = Extract<ResultOf<typeof NO_AS_CONST>, { cancelled: false }>
type _NoAsConstButton = Expect<Equal<SubmittedNoAsConst['button'], 'continue' | 'retry'>>

// ---------------------------------------------------------------------------
// (3) `validate:` is rejected at the type level — `AskInput` does not have it.
// ---------------------------------------------------------------------------

type AnyAskInput = AskInput<Record<string, never>, 'ok'>
type _NoValidateOnAskInput = Expect<
  Equal<'validate' extends keyof AnyAskInput ? true : false, false>
>

// Suppress unused-binding warnings — these declarations are the test.
export type {
  _CancelledFieldsKey,
  _CancelledFieldsValue,
  _CancelledHasNoButton,
  _NoAsConstButton,
  _NoValidateOnAskInput,
  _SubmittedButton,
  _SubmittedNotes,
}
