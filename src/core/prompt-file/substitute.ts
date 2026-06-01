import { PromptFileError } from './errors.ts'

// PromptVars — only string, number, boolean primitives are allowed.
// Anything richer (objects, arrays, null, undefined, symbols, bigints) is
// rejected at runtime by assertPromptVars. Composition cases that want richer
// values use `loadPrompt` instead.
export type PromptVars = Readonly<Record<string, string | number | boolean>>

// `PromptVarsBound` — the generic-parameter constraint used by `Step<T, V>`
// and `RunOverrides<V>`. Slightly wider than `PromptVars` because a typed
// optional placeholder (e.g. `{ x?: string }`) introduces `| undefined` into
// the value type under TypeScript's default optional-property semantics.
// Runtime `assertPromptVars` still rejects an explicit `undefined` value; the
// canonical way to opt out of an optional placeholder is to omit the key.
export type PromptVarsBound = Readonly<Record<string, string | number | boolean | undefined>>

// Matches {{name}}, {{ name }}, {{name?}}, {{ name? }}, {{ name ? }}.
// Identifier must look like a JS variable name. Optional `?` (capture group 2)
// flags the placeholder as substituting to '' when no matching key is
// supplied. Whitespace tolerant inside the braces and around the `?` marker.
// The regex is exported (`PLACEHOLDER_RE`) so the codegen extractor (U7) can
// import the *same* constant — runtime and compile-time must agree on what a
// placeholder is.
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\?)?\s*\}\}/g

interface SubstituteContext {
  readonly stepName?: string
  readonly promptFile?: string
}

export function substitute(
  template: string,
  vars: PromptVars,
  ctx: SubstituteContext = {},
): string {
  assertPromptVars(vars, ctx)
  const { required, optional } = collectPlaceholders(template)
  const providedKeys = new Set(Object.keys(vars))
  const missing: string[] = []
  for (const name of required) if (!providedKeys.has(name)) missing.push(name)
  const extra: string[] = []
  for (const key of providedKeys) {
    if (!required.has(key) && !optional.has(key)) extra.push(key)
  }

  if (missing.length > 0 && extra.length === 0) {
    throw new PromptFileError(
      formatPrefix(ctx) +
        `prompt template references {{${missing.join('}}, {{')}}} but no value was supplied — ` +
        'add the matching key(s) to `vars`',
      { cause: 'missing-placeholder', missing, extra, ...ctx },
    )
  }
  if (extra.length > 0 && missing.length === 0) {
    throw new PromptFileError(
      formatPrefix(ctx) +
        `vars supplied key(s) [${extra.join(', ')}] that the prompt template does not use — ` +
        'remove the unused key(s) or use them as {{placeholder}} in the template',
      { cause: 'extra-key', missing, extra, ...ctx },
    )
  }
  if (missing.length > 0 && extra.length > 0) {
    // Both directions failed — the most common cause is a typo. Lead with
    // missing so the message reads "template wants X, got Y instead".
    throw new PromptFileError(
      formatPrefix(ctx) +
        `prompt template references {{${missing.join('}}, {{')}}} but vars supplied [${extra.join(
          ', ',
        )}] — check for a typo (placeholder name vs key name must match exactly)`,
      { cause: 'missing-placeholder', missing, extra, ...ctx },
    )
  }

  return template.replace(PLACEHOLDER_RE, (_match, name: string, optionalMarker?: string) => {
    // Required placeholders are guaranteed to have a key by now (the missing
    // check ran above). Optional placeholders may be absent — substitute the
    // empty string. We deliberately don't use `String(undefined)` here to
    // avoid leaking 'undefined' into prompts.
    if (!Object.hasOwn(vars, name)) {
      return optionalMarker === '?' ? '' : String(vars[name])
    }
    return String(vars[name])
  })
}

interface PlaceholderSets {
  readonly required: Set<string>
  readonly optional: Set<string>
}

function collectPlaceholders(template: string): PlaceholderSets {
  const required = new Set<string>()
  const optional = new Set<string>()
  // Re-create iteration to avoid stateful global regex re-use.
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  let m: RegExpExecArray | null = re.exec(template)
  while (m !== null) {
    const name = m[1]
    const opt = m[2]
    if (name !== undefined) {
      if (opt === '?') optional.add(name)
      else required.add(name)
    }
    m = re.exec(template)
  }
  // A name that appears both required and optional in the same template is
  // treated as required — promotion to required is the strict choice, since a
  // required reference is the harder contract for the caller to satisfy.
  for (const name of required) optional.delete(name)
  return { required, optional }
}

export function assertPromptVars(
  vars: unknown,
  ctx: SubstituteContext = {},
): asserts vars is PromptVars {
  if (vars === null || typeof vars !== 'object') {
    throw new PromptFileError(
      formatPrefix(ctx) +
        `vars must be a plain object of string|number|boolean — got ${describeType(vars)}`,
      { cause: 'unsupported-type', ...ctx },
    )
  }
  if (Array.isArray(vars)) {
    throw new PromptFileError(
      `${formatPrefix(ctx)}vars must be a plain object of string|number|boolean — got array`,
      { cause: 'unsupported-type', ...ctx },
    )
  }
  for (const [key, value] of Object.entries(vars)) {
    const t = describeType(value)
    if (t === 'string' || t === 'number' || t === 'boolean') continue
    throw new PromptFileError(
      formatPrefix(ctx) +
        `vars.${key} has unsupported type "${t}" — only string|number|boolean are allowed. ` +
        'For rich composition (concatenating fragments), use `loadPrompt()` and pass the result as `prompt:` instead',
      { cause: 'unsupported-type', ...ctx },
    )
  }
}

function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function formatPrefix(ctx: SubstituteContext): string {
  if (ctx.stepName !== undefined) return `step.define("${ctx.stepName}"): `
  if (ctx.promptFile !== undefined) return `loadPrompt("${ctx.promptFile}"): `
  return ''
}
