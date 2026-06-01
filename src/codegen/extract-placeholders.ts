// Runtime placeholder extractor used by `orch types` codegen.
//
// Mirrors the type-level extractor in `src/core/prompt-file/template-vars.ts`
// (`VarsOf<T>`). The two share `PLACEHOLDER_RE`, re-exported deliberately
// from the prompt-file barrel so the codegen, the runtime substituter, and
// the TLT extractor cannot drift on what counts as a placeholder. Importing
// via the barrel keeps the single-barrel rule (CLAUDE.md rule 7) intact.

import { PLACEHOLDER_RE } from '../core/prompt-file/index.ts'

export interface ExtractedVars {
  /** Required placeholders (`{{name}}`), in source order with duplicates removed. */
  readonly required: readonly string[]
  /** Optional placeholders (`{{name?}}`), in source order with duplicates removed. */
  readonly optional: readonly string[]
}

/**
 * Parse a prompt template and return the required + optional placeholder
 * names. Duplicates within a category collapse to a single entry; a name that
 * appears both as `{{x}}` and `{{x?}}` is promoted to required (the stricter
 * contract — `assemblePrompt` enforces a value for it).
 */
export function extractPlaceholders(template: string): ExtractedVars {
  const required: string[] = []
  const optional: string[] = []
  const seenRequired = new Set<string>()
  const seenOptional = new Set<string>()

  // Re-create iteration so we don't mutate the shared exported regex.
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  let m: RegExpExecArray | null = re.exec(template)
  while (m !== null) {
    const name = m[1]
    const opt = m[2]
    if (name !== undefined) {
      if (opt === '?') {
        if (!seenOptional.has(name)) {
          seenOptional.add(name)
          optional.push(name)
        }
      } else {
        if (!seenRequired.has(name)) {
          seenRequired.add(name)
          required.push(name)
        }
      }
    }
    m = re.exec(template)
  }

  // Required wins when a name appears in both categories — matches
  // `collectPlaceholders` in `substitute.ts`.
  const filteredOptional = optional.filter((name) => !seenRequired.has(name))

  return { required, optional: filteredOptional }
}
