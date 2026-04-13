import type { Step } from './step.ts'
import { stepName } from './types.ts'

/**
 * The return type of a commit step: contains the SHA of the created commit,
 * or `null` if the working tree was clean (nothing to commit).
 */
export interface CommitResult {
  readonly sha: string
}

const COMMIT_PREFIX = 'commit:'

/**
 * Slugifies a commit message into a step-name-safe string.
 * Inline — not a separate module (YAGNI).
 */
function slugify(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Creates a commit step that stages all changes and commits them.
 *
 * `await run(commit('after research'))` produces a `commit:after-research`
 * step that calls `git add . && git commit -m 'after research'`.
 *
 * Returns `{ sha }` when changes were committed, or `null` when the
 * working tree was already clean (natural on resume).
 *
 * **Security note:** `git add .` stages everything agents produce, including
 * potential secrets (`.env`, `*.pem`). A future phase adds denylist scan
 * before staging.
 */
export function commit(message: string): Step<CommitResult | null> {
  if (message.length === 0) {
    throw new Error('commit() message must not be empty')
  }
  if (message.trim().length === 0) {
    throw new Error('commit() message must not be whitespace-only')
  }
  if (message.includes('\0')) {
    throw new Error('commit() message must not contain null bytes')
  }
  if (message.includes('\n')) {
    throw new Error('commit() message must not contain newline characters')
  }

  const slug = slugify(message)
  if (slug.length === 0) {
    throw new Error(
      `commit() message "${message}" produces an empty slug — use alphanumeric characters`,
    )
  }

  const name = stepName(`${COMMIT_PREFIX}${slug}`)

  return Object.freeze({
    name,
    config: { kind: 'commit' as const, message },
  })
}
