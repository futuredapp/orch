// MIGRATED → tests-new/unit/core/prompt-file/template-vars.test-d.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Compile-time tests for the vendored TLT extractor. No runtime assertions —
// failures land at `tsc --noEmit` time. Each `Expect<Equal<...>>` row is one
// row of behavior; see SKILL.md's reference for the assertion pattern.

import type {
  ExtractOptionalVars,
  ExtractRequiredVars,
  VarsOf,
} from '../../../../src/core/prompt-file/template-vars.ts'
import type { Equal, Expect } from '../../../helpers/type-assertions.ts'

// ---------------------------------------------------------------------------
// ExtractRequiredVars
// ---------------------------------------------------------------------------

type _Req_Single = Expect<Equal<ExtractRequiredVars<'Hi {{name}}'>, 'name'>>
type _Req_DedupeSameKey = Expect<Equal<ExtractRequiredVars<'Hi {{name}} {{name}}'>, 'name'>>
type _Req_ThreeKeys = Expect<Equal<ExtractRequiredVars<'Hi {{a}} {{b}} {{c}}'>, 'a' | 'b' | 'c'>>
type _Req_None = Expect<Equal<ExtractRequiredVars<'plain text, no vars'>, never>>
type _Req_Whitespace = Expect<Equal<ExtractRequiredVars<'Hi {{ name }}'>, 'name'>>
type _Req_OptionalExcluded = Expect<Equal<ExtractRequiredVars<'Hi {{name?}}'>, never>>
type _Req_MixedOnlyRequired = Expect<Equal<ExtractRequiredVars<'Hi {{a}} {{b?}}'>, 'a'>>

// ---------------------------------------------------------------------------
// ExtractOptionalVars
// ---------------------------------------------------------------------------

type _Opt_Single = Expect<Equal<ExtractOptionalVars<'Hi {{name?}}'>, 'name'>>
type _Opt_Whitespace = Expect<Equal<ExtractOptionalVars<'Hi {{ name? }}'>, 'name'>>
type _Opt_WhitespaceAroundMarker = Expect<Equal<ExtractOptionalVars<'Hi {{ name ? }}'>, 'name'>>
type _Opt_Mixed = Expect<Equal<ExtractOptionalVars<'Hi {{a}} {{b?}}'>, 'b'>>
type _Opt_None = Expect<Equal<ExtractOptionalVars<'plain'>, never>>
type _Opt_RequiredOnly = Expect<Equal<ExtractOptionalVars<'Hi {{name}}'>, never>>

// ---------------------------------------------------------------------------
// VarsOf — the composed contract
// ---------------------------------------------------------------------------

type _Vars_SingleRequired = Expect<
  Equal<VarsOf<'Hi {{name}}'>, { name: string | number | boolean }>
>
type _Vars_SingleOptional = Expect<
  Equal<VarsOf<'Hi {{name?}}'>, { name?: string | number | boolean }>
>
type _Vars_MixedRequiredAndOptional = Expect<
  Equal<
    VarsOf<'Hi {{a}} {{b?}}'>,
    { a: string | number | boolean } & { b?: string | number | boolean }
  >
>
// The "no vars" shape resolves directly to `Record<string, never>` — VarsOf
// special-cases the all-empty branch so the default matches the `Step<TResult,
// TVars>` default exactly. `Record<string, never>` (not `{}`) is the
// load-bearing sentinel: it rejects any string key, which makes
// `run(STEP, { vars: { x: 'y' } })` a compile-time error for a no-vars step.
// `{}` would silently accept the extra key.
type _Vars_NoneIsEmpty = Expect<Equal<VarsOf<'plain'>, Record<string, never>>>

// The `Record<string, never>` sentinel for "no vars required" rejects extra
// keys at the `run()` site — its index signature maps any string key to
// `never`, so the only assignable object is `{}`. `keyof Record<string, never>`
// is `string` (the index-signature key type), but assigning `{ x: 'y' }` to a
// `Record<string, never>` is a type error because `'y'` is not assignable to
// `never`. That asymmetry is what gives us strict excess-key checking on a
// no-vars step.
type _NoVars_KeyofIsString = Expect<Equal<keyof VarsOf<'plain'>, string>>

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

// Multi-line prompt with placeholders across line breaks.
type _Vars_MultiLine = Expect<
  Equal<
    VarsOf<'line1 {{topic}}\nline2 {{depth?}}'>,
    { topic: string | number | boolean } & { depth?: string | number | boolean }
  >
>

// `${greeting}` style is NOT template syntax in orch — never extracted.
type _Req_DollarSyntaxIgnored = Expect<Equal<ExtractRequiredVars<'${greeting}'>, never>>

// Long-prompt regression — make sure a 25-placeholder prompt still type-checks
// without hitting TypeScript's conditional-recursion limit. Real orch prompts
// fit well under this bound; the `template-vars.ts` header documents the
// observed ceiling (~25–50 placeholders depending on whitespace shape). The
// union itself is too noisy to enumerate, so we just assert it resolves to
// *some* string union by checking it is assignable to `string`.
type _LongPrompt_StillTypeChecks = Expect<
  Equal<
    ExtractRequiredVars<// 25 placeholders concatenated.
    `{{k01}}{{k02}}{{k03}}{{k04}}{{k05}}{{k06}}{{k07}}{{k08}}{{k09}}{{k10}}{{k11}}{{k12}}{{k13}}{{k14}}{{k15}}{{k16}}{{k17}}{{k18}}{{k19}}{{k20}}{{k21}}{{k22}}{{k23}}{{k24}}{{k25}}`> extends string
      ? true
      : false,
    true
  >
>

// ---------------------------------------------------------------------------
// Suppress unused-binding warnings — the declarations ARE the test.
// ---------------------------------------------------------------------------

export type {
  _LongPrompt_StillTypeChecks,
  _NoVars_KeyofIsString,
  _Opt_Mixed,
  _Opt_None,
  _Opt_RequiredOnly,
  _Opt_Single,
  _Opt_Whitespace,
  _Opt_WhitespaceAroundMarker,
  _Req_DedupeSameKey,
  _Req_DollarSyntaxIgnored,
  _Req_MixedOnlyRequired,
  _Req_None,
  _Req_OptionalExcluded,
  _Req_Single,
  _Req_ThreeKeys,
  _Req_Whitespace,
  _Vars_MixedRequiredAndOptional,
  _Vars_MultiLine,
  _Vars_NoneIsEmpty,
  _Vars_SingleOptional,
  _Vars_SingleRequired,
}
