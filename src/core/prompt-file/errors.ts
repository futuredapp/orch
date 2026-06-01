// PromptFileError — single error class for the prompt-file pipeline.
//
// Carries a structured `cause` discriminator so tests can branch on category
// (mutex / vars-on-define / missing-placeholder / extra-key /
// unsupported-type / read-failed / traversal) without grepping messages. The
// message itself follows the existing orch convention used by `step.define`:
//   step.define("<name>"): <what was wrong> — <how to fix>
// For loadPrompt, the call-site form is:
//   loadPrompt("<path>"): <what was wrong> — <how to fix>

export type PromptFileErrorCause =
  | 'mutex'
  | 'vars-on-define'
  | 'missing-placeholder'
  | 'extra-key'
  | 'unsupported-type'
  | 'read-failed'
  | 'traversal'
  | 'empty-prompt'

export interface PromptFileErrorDetails {
  readonly cause: PromptFileErrorCause
  readonly stepName?: string
  readonly promptFile?: string
  readonly missing?: ReadonlyArray<string>
  readonly extra?: ReadonlyArray<string>
}

export class PromptFileError extends Error {
  override readonly cause: PromptFileErrorCause
  readonly stepName: string | undefined
  readonly promptFile: string | undefined
  readonly missing: ReadonlyArray<string> | undefined
  readonly extra: ReadonlyArray<string> | undefined

  constructor(message: string, details: PromptFileErrorDetails) {
    super(message)
    this.name = 'PromptFileError'
    this.cause = details.cause
    this.stepName = details.stepName
    this.promptFile = details.promptFile
    this.missing = details.missing
    this.extra = details.extra
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
