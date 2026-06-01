// Compile-time extractor for `{{placeholder}}` tokens in a string-literal
// prompt. Required keys via `{{x}}`; optional keys via `{{x?}}`. Whitespace
// inside the braces is tolerated so the type-level extractor agrees with the
// runtime regex in `./substitute.ts`.
//
// Prior art: the conditional-template-literal-type idea is identical to the
// extractors in d-kimuson/type-safe-prompt and SchoolAI/ts-prompt. We vendor a
// ~25-line version (with the `{{x?}}` extension, whitespace `Trim`, and the
// `VarsOf<T>` composition) rather than take a dependency on either micro-
// package. Attribution preserved here as the canonical pointer.
//
// TypeScript's conditional-recursion ceiling caps the extractor at roughly
// 25–50 placeholders per template, depending on inner-whitespace shape (each
// `{{ x }}` runs Trim<…> recursively before yielding). Orch prompts fit
// comfortably under that bound; authors who hit it can split the prompt with
// `loadPrompt()` or move sub-templates into `promptFile:` sidecars.

// Trim a single space character off both ends. TypeScript's template-literal
// types only match concrete characters, so a recursive single-char trim is the
// cleanest way to be whitespace-tolerant. Tabs/newlines are uncommon inside
// `{{...}}` but trimmed here too for parity with the runtime `\s*` regex.
type Whitespace = ' ' | '\t' | '\n' | '\r'
type Trim<S extends string> = S extends `${Whitespace}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Whitespace}`
    ? Trim<R>
    : S

// Strip a trailing `?` (after any inner whitespace has been trimmed). Used to
// peel the optional marker off `{{x?}}` placeholders so the resulting key name
// matches what the runtime substituter sees.
type StripOptional<S extends string> = S extends `${infer K}?` ? Trim<K> : S

/**
 * Union of REQUIRED placeholder keys in a literal prompt string.
 *
 * - `ExtractRequiredVars<'Hi {{name}}'>` → `'name'`
 * - `ExtractRequiredVars<'Hi {{name?}}'>` → `never`
 * - `ExtractRequiredVars<'plain'>` → `never`
 */
export type ExtractRequiredVars<T extends string> = T extends `${string}{{${infer K}}}${infer Rest}`
  ? Trim<K> extends `${string}?`
    ? ExtractRequiredVars<Rest>
    : Trim<K> | ExtractRequiredVars<Rest>
  : never

/**
 * Union of OPTIONAL placeholder keys (those marked with a `?` suffix) in a
 * literal prompt string.
 *
 * - `ExtractOptionalVars<'Hi {{name?}}'>` → `'name'`
 * - `ExtractOptionalVars<'Hi {{name}}'>` → `never`
 */
export type ExtractOptionalVars<T extends string> = T extends `${string}{{${infer K}}}${infer Rest}`
  ? Trim<K> extends `${string}?`
    ? StripOptional<Trim<K>> | ExtractOptionalVars<Rest>
    : ExtractOptionalVars<Rest>
  : never

// Internal: build the required-vars half of `VarsOf<T>`. Resolves to
// `Record<string, never>` (the "rejects any key" sentinel) when there are no
// required placeholders so the intersection with the optional half stays
// clean.
//
// `Record<string, never>` — not `Record<never, never>` / `{}` — is the
// load-bearing sentinel. `{}` accepts any non-nullish value, which would
// silently accept `vars: { extra: 'y' }` on a no-vars step. The
// `Record<string, never>` form maps every string key to `never`, so any
// supplied key (other than the empty object) is a type error.
type RequiredVarsShape<T extends string> = [ExtractRequiredVars<T>] extends [never]
  ? Record<string, never>
  : { [K in ExtractRequiredVars<T>]: string | number | boolean }

// Internal: build the optional-vars half of `VarsOf<T>`.
type OptionalVarsShape<T extends string> = [ExtractOptionalVars<T>] extends [never]
  ? Record<string, never>
  : { [K in ExtractOptionalVars<T>]?: string | number | boolean }

/**
 * The `vars:` contract inferred from a literal prompt string.
 *
 * - `VarsOf<'Hi {{name}}'>` → `{ name: string | number | boolean }`
 * - `VarsOf<'Hi {{name?}}'>` → `{ name?: string | number | boolean }`
 * - `VarsOf<'Hi {{a}} {{b?}}'>` →
 *     `{ a: string | number | boolean } & { b?: string | number | boolean }`
 * - `VarsOf<'plain'>` → `Record<never, never>`
 *
 * The `Record<never, never>` sentinel for "no vars" lets a no-vars step still
 * reject extra keys at the `run(STEP, { vars: ... })` call site — distinct
 * from "any vars OK" (which would be `PromptVars`).
 *
 * The shape is chosen per case so each side stays clean: pure-required and
 * pure-optional prompts produce a single object literal; mixed prompts use the
 * intersection. Flattening via a mapped Prettify is intentionally avoided
 * because the homomorphic mapping widens the value type and breaks the
 * `extends PromptVars` constraint that `Step<TResult, TVars>` demands.
 */
export type VarsOf<T extends string> = [ExtractRequiredVars<T>] extends [never]
  ? [ExtractOptionalVars<T>] extends [never]
    ? Record<string, never>
    : OptionalVarsShape<T>
  : [ExtractOptionalVars<T>] extends [never]
    ? RequiredVarsShape<T>
    : RequiredVarsShape<T> & OptionalVarsShape<T>
