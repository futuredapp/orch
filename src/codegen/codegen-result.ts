import type { PromptFileErrorCause } from '../core/prompt-file/index.ts'
import type { Path } from '../services/index.ts'

export interface CodegenError {
  readonly path: Path
  readonly message: string
  /**
   * When the underlying failure is a `PromptFileError`, surface its
   * structured discriminator so JSON consumers (`orch types --format=json`)
   * can branch on failure kind instead of grepping `message`. Undefined for
   * generic errors (read failures, unexpected throws).
   */
  readonly cause?: PromptFileErrorCause
  /** When the error reports unsatisfied placeholders, list them here. */
  readonly missing?: readonly string[]
  /** When the error reports unrecognized var keys, list them here. */
  readonly extra?: readonly string[]
}

export interface CodegenResult {
  /** Paths whose sidecars were freshly written (or rewritten with new content). */
  readonly written: readonly Path[]
  /** Paths whose sidecars already matched on disk and were left alone. */
  readonly skipped: readonly Path[]
  /** Errors encountered per-source — collected, not thrown. */
  readonly errors: readonly CodegenError[]
}
