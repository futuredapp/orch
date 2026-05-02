import type { StepName } from '../../core/types.ts'
import type { Host } from '../../hosts/index.ts'

// ---------------------------------------------------------------------------
// PromptService — the port the executor calls to render an interactive prompt.
// ---------------------------------------------------------------------------
//
// The port speaks `Record<string, string>` for fields. The const-generic
// `AskResult` lives in `src/core/ask.ts`; `runAskStep` casts the port's
// `PromptResult` into the typed shape after merging in the field record.
// Keeping the port untyped over fields means `PromptService` doesn't carry
// generics across the seam — same pattern as `Runner.extractStructuredOutput()`
// returning `unknown` and the executor casting after Zod-parse.

export interface PromptField {
  readonly name: string
  readonly placeholder?: string
}

export interface PromptSpec {
  readonly question: string
  readonly fields: ReadonlyArray<PromptField>
  readonly buttons: ReadonlyArray<string>
}

export interface PromptCtx {
  readonly stepName: StepName
  readonly host: Host
}

export type PromptResult =
  | { readonly cancelled: true; readonly fields: Readonly<Record<string, string>> }
  | {
      readonly cancelled: false
      readonly button: string
      readonly fields: Readonly<Record<string, string>>
    }

export interface PromptService {
  ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult>
}
