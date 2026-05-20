/**
 * ConfirmService — minimal yes/no port used by config-free commands
 * (`orch init`, `orch new`) that need a binary opt-in without the full
 * `PromptService.ask()` machinery (StepName, Host, fields[], buttons[]).
 *
 * The contract is intentionally narrow: one question, one boolean back.
 * Defaults shape the displayed suffix (`[Y/n]` for true, `[y/N]` for false)
 * and the answer returned on empty input or after parser retries are
 * exhausted.
 */
export interface ConfirmService {
  confirm(question: string, defaultAnswer: boolean): Promise<boolean>
}

/**
 * Parse a single line of yes/no input into a boolean.
 *
 * Rules:
 *  - empty string → `defaultAnswer` (covers bare Enter)
 *  - case-insensitive: `y` / `yes` → `true`, `n` / `no` → `false`
 *  - anything else → `undefined` (caller decides whether to re-prompt)
 */
export function parseYesNo(input: string, defaultAnswer: boolean): boolean | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return defaultAnswer
  const lower = trimmed.toLowerCase()
  if (lower === 'y' || lower === 'yes') return true
  if (lower === 'n' || lower === 'no') return false
  return undefined
}

/**
 * Render the `[Y/n]` / `[y/N]` suffix that signals the default answer.
 * Uppercase letter is the default.
 */
export function confirmSuffix(defaultAnswer: boolean): string {
  return defaultAnswer ? '[Y/n]' : '[y/N]'
}
