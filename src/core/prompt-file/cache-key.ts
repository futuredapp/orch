import { createHash } from 'node:crypto'
import type { PromptVars } from './substitute.ts'

// Canonical JSON form of a PromptVars object — used as the input to
// `stableHashHex`. Properties:
//   - Keys are ASCII-sorted (so insertion order does not affect the hash).
//   - String values use JSON.stringify (so embedded quotes / backslashes are
//     escaped consistently).
//   - Numbers and booleans use String() — matching what `substitute()` injects
//     into the rendered prompt. This intentionally collapses `42` and `42.0`
//     onto the same canonical decimal because they substitute identically.
//   - Keys whose value is `undefined` are omitted, supporting optional-var
//     semantics where omitting the key is the canonical way to opt out.
//   - No whitespace. The output is one tight string suitable for hashing.
//
// Note on NaN: `String(NaN)` is the literal `'NaN'`. We accept that (rather
// than throwing) because workflows passing NaN are buggy upstream, but the
// hash function must remain total — a thrown error here would surface deep
// inside cache-key derivation, far from the source of the bug.
export function canonicalJson(vars: PromptVars): string {
  const keys = Object.keys(vars).sort()
  const parts: string[] = []
  for (const key of keys) {
    const value = vars[key]
    if (value === undefined) continue
    const encoded = typeof value === 'string' ? JSON.stringify(value) : String(value)
    parts.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${parts.join(',')}}`
}

// Deterministic 16-char hex digest of a PromptVars object, ignoring key
// insertion order. Empty vars → empty string (sentinel: callers short-circuit
// the cache-key fold when the hash is empty).
//
// 16 hex chars = 64 bits of collision space. That is ample for the number of
// `run(STEP, { vars })` calls in any single workflow run, and the hex
// vocabulary fits cleanly inside `STEP_NAME_PATTERN` when concatenated as
// `name:vars=<hex>`.
export function stableHashHex(vars: PromptVars): string {
  if (Object.keys(vars).length === 0) return ''
  return createHash('sha256').update(canonicalJson(vars)).digest('hex').slice(0, 16)
}
