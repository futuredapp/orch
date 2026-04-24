// ---------------------------------------------------------------------------
// Secret redaction for SessionLogger.
// ---------------------------------------------------------------------------
//
// One hardcoded regex, one function, one behaviour: a key that looks like a
// secret has its value replaced with `***`. The default everywhere is
// `envKeys` (no values at all); `redactEnvValues` is only reached when the
// caller explicitly opts in (e.g. `run.meta.json` under
// `ORCH_LOG_ENV_VALUES=1`).
//
// Keeping the regex in one place lets the plan's "one function" rule hold:
// any writer that touches env goes through here. Unit tests own the contract.

const SECRET_KEY_PATTERN = /^(ANTHROPIC_|CLAUDE_)|.*_TOKEN$|.*_SECRET$|.*_KEY$|.*_PASSWORD$/

/** True when the env key should have its value redacted. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key)
}

/** Returns the sorted list of env keys — the default shape in every log. */
export function envKeys(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return Object.keys(env).sort()
}

/**
 * Returns a new env-shaped record where every secret key's value is replaced
 * with `***`. Reached only when the caller explicitly logs values (gated by
 * `ORCH_LOG_ENV_VALUES=1` in production call sites).
 */
export function redactEnvValues(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env).sort()) {
    const value = env[key]
    if (value === undefined) continue
    out[key] = isSecretKey(key) ? '***' : value
  }
  return out
}

/**
 * Redact any `KEY=value` pairs inside a shell-style reproduce command. Used
 * when writing spawns' `reproduce` strings into log files — the command is
 * meant to be copy-paste reproducible for benign env vars, but must never
 * leak secrets. Conservative tokenizer: we match `KEY=…` segments up to the
 * next whitespace; values containing whitespace should be quoted by the
 * caller (the CLI wiring is), so the tokenizer is enough for our call sites.
 */
export function redactReproduceCommand(cmd: string): string {
  return cmd.replace(/([A-Z_][A-Z0-9_]*)=([^\s]+)/g, (_match, key: string, value: string) => {
    if (isSecretKey(key)) return `${key}=***`
    return `${key}=${value}`
  })
}
