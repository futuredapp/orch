import type { Step } from './step.ts'
import { stepName } from './types.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
//
// `ask()` is the user-input step primitive. v1 has one field shape — a bare
// `{ placeholder?: string }` — used directly without a `kind` discriminator.
// When a second field kind lands (select, multi-line, etc.) introduce
// `kind: 'text' | 'select' | …` and per-kind constructors then.

export interface AskField {
  readonly placeholder?: string
}

export interface AskFields {
  readonly [name: string]: AskField
}

export type FieldValues<F extends AskFields> = {
  readonly [K in keyof F]: string
}

/**
 * Discriminated union return shape of `ask()`. TS narrows naturally on
 * `result.cancelled`: the `cancelled: true` branch carries `Partial<>` of
 * the field values typed before Esc, while the `cancelled: false` branch
 * carries every field plus the chosen `button` literal.
 */
export type AskResult<F extends AskFields, B extends string> =
  | { readonly cancelled: true; readonly fields: Partial<FieldValues<F>> }
  | ({ readonly cancelled: false; readonly button: B } & FieldValues<F>)

export interface AskInput<F extends AskFields, B extends string> {
  readonly name: string
  readonly question: string
  readonly fields?: F
  readonly buttons: ReadonlyArray<B>
  /**
   * Default value for `--noninteractive` runs (CI, scheduled, agent-on-agent).
   * Missing field values are zero-filled with `''` — a conscious design choice
   * so authors don't have to enumerate every empty field.
   */
  readonly defaultWhenNoninteractive?:
    | { readonly cancelled: true }
    | ({ readonly cancelled?: false; readonly button: B } & Partial<FieldValues<F>>)
}

export interface AskStepConfig {
  readonly kind: 'ask'
  readonly question: string
  readonly fields: AskFields
  readonly buttons: ReadonlyArray<string>
  readonly defaultWhenNoninteractive?: unknown
}

const ASK_PREFIX = 'ask:'
const MAX_STEP_NAME_LENGTH = 128
const MAX_SLUG_LENGTH = MAX_STEP_NAME_LENGTH - ASK_PREFIX.length

const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/

/**
 * Belt-and-suspenders against prototype-pollution: the Ink renderer does
 * `Object.fromEntries(spec.fields.map(f => [f.name, '']))`, which is a known
 * sink without a guard.
 */
const FORBIDDEN_FIELD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Slugifies a name into a step-name-safe string. Same rules as `commit.ts`
 * and `worktree.ts` — keep in sync.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ---------------------------------------------------------------------------
// ask() factory — const-generic over fields and buttons
// ---------------------------------------------------------------------------

/**
 * Build a typed prompt step. `await run(ASK)` resolves to a discriminated
 * `AskResult` whose `button` literal is narrowed to the string-literal union
 * of the supplied buttons (TS const-generic on `B`).
 *
 * Example:
 * ```ts
 * const ASK_CONTINUE = ask({
 *   name: 'continue',
 *   question: 'Continue?',
 *   fields: { notes: { placeholder: 'optional' } },
 *   buttons: ['continue', 'retry', 'abort'],
 *   defaultWhenNoninteractive: { button: 'continue' },
 * })
 * const r = await run(ASK_CONTINUE)
 * if (!r.cancelled) {
 *   r.button // 'continue' | 'retry' | 'abort'
 *   r.notes  // string
 * }
 * ```
 */
export function ask<F extends AskFields, const B extends string>(
  input: AskInput<F, B>,
): Step<AskResult<F, B>> {
  validateName(input.name)
  validateQuestion(input.question)
  validateButtons(input.buttons)
  validateFieldNames(input.fields ?? {})

  const slug = slugify(input.name)
  if (slug.length === 0) {
    throw new Error(
      `ask() name "${input.name}" produces an empty slug — use alphanumeric characters`,
    )
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `ask() name "${input.name}" sanitizes to ${slug.length} chars; max is ${MAX_SLUG_LENGTH}`,
    )
  }

  const name = stepName(`${ASK_PREFIX}${slug}`)

  const config: AskStepConfig = {
    kind: 'ask' as const,
    question: input.question,
    // Shallow freeze: the `fields` map is sealed, but each individual `AskField`
    // is the caller's literal — currently safe (only `placeholder?: string` is
    // mutable, which is harmless). When a second field kind lands and field
    // values gain nested objects (e.g. `select.options`), each per-kind
    // constructor MUST freeze its own internals; do NOT rely on this freeze.
    fields: Object.freeze({ ...(input.fields ?? {}) }),
    buttons: Object.freeze([...input.buttons]),
    ...(input.defaultWhenNoninteractive !== undefined
      ? { defaultWhenNoninteractive: input.defaultWhenNoninteractive }
      : {}),
  }

  return Object.freeze({ name, config }) as Step<AskResult<F, B>>
}

// ---------------------------------------------------------------------------
// Validation — each rule has its own error message naming the offending input
// ---------------------------------------------------------------------------

function validateName(name: string): void {
  if (name.length === 0) {
    throw new Error('ask() name must not be empty')
  }
  if (name.trim().length === 0) {
    throw new Error('ask() name must not be whitespace-only')
  }
  if (name.includes('\0')) {
    throw new Error('ask() name must not contain null bytes')
  }
  if (name.includes('\n') || name.includes('\r')) {
    throw new Error('ask() name must not contain newline characters')
  }
  if (name.startsWith('-')) {
    throw new Error('ask() name must not begin with a dash')
  }
}

function validateQuestion(question: string): void {
  if (question.length === 0) {
    throw new Error('ask() question must not be empty')
  }
  if (question.trim().length === 0) {
    throw new Error('ask() question must not be whitespace-only')
  }
  if (question.includes('\0')) {
    throw new Error('ask() question must not contain null bytes')
  }
}

function validateButtons(buttons: ReadonlyArray<string>): void {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('ask() buttons must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const [idx, b] of buttons.entries()) {
    validateButton(idx, b)
    if (seen.has(b)) {
      throw new Error(`ask() buttons must be unique; "${b}" appears more than once`)
    }
    seen.add(b)
  }
}

function validateButton(idx: number, b: unknown): void {
  if (typeof b !== 'string') {
    throw new Error(`ask() buttons[${idx}] must be a string`)
  }
  if (b.length === 0) {
    throw new Error(`ask() buttons[${idx}] must not be empty`)
  }
  if (b.trim().length === 0) {
    throw new Error(`ask() buttons[${idx}] must not be whitespace-only`)
  }
  if (b.includes('\0')) {
    throw new Error(`ask() buttons[${idx}] must not contain null bytes`)
  }
  if (b.includes('\n') || b.includes('\r')) {
    throw new Error(`ask() buttons[${idx}] must not contain newline characters`)
  }
}

function validateFieldNames(fields: AskFields): void {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      throw new Error(`ask() field name "${key}" is reserved (prototype-pollution guard)`)
    }
    if (!FIELD_KEY_PATTERN.test(key)) {
      throw new Error(
        `ask() field name "${key}" is invalid — must match /^[a-zA-Z][a-zA-Z0-9_]*$/ ` +
          '(no digits at start, no hyphens, no underscores at start, no $)',
      )
    }
  }
}
