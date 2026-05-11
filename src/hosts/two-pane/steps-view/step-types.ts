// ---------------------------------------------------------------------------
// Step types — the discriminated unions consumed across the steps-view module.
// ---------------------------------------------------------------------------
//
// Hoisted out of `steps-view-model.ts` so the live-overlay + projector files
// can import the types without dragging in the factory + composition glue.

export type StepStatus = 'pending' | 'running' | 'interactive' | 'completed' | 'failed' | 'cached'

export type StepRow =
  | {
      readonly kind: 'agent'
      readonly mode: 'autonomous'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly transcriptPath?: string
    }
  | {
      readonly kind: 'agent'
      readonly mode: 'interactive'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly sessionId?: string
    }
  | {
      readonly kind: 'command'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
    }
  | {
      readonly kind: 'commit'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
    }
  | {
      readonly kind: 'worktree'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
    }
  | {
      readonly kind: 'ask'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
    }

export interface RunHeader {
  readonly runId: string
  readonly workflowName: string
  readonly startedAt: number
}

export interface EndOfRunSummary {
  readonly endedAt: number
  readonly durationMs: number
  readonly stepsTotal: number
  readonly stepsCompleted: number
  readonly stepsFailed: number
}

// `view.mode` is the persistent footer indicator. `'live'` while following the
// most-recent live source (or rollup); `{mode:'replay', stepName}` after Enter
// on a past step. Independent of `banner` — the banner is transient feedback,
// `view` is the durable mode.
export type ViewMode =
  | { readonly mode: 'live' }
  | { readonly mode: 'replay'; readonly stepName: string }

// Single-slot, last-write-wins banner. `seq` is a monotonic counter assigned by
// the controller's `emitBanner` — the renderer keys its auto-dismiss timeout on
// `seq` (NOT on `text`) so rapid successive banners with identical text reliably
// restart the timer instead of being deduped by React's effect dependency check.
// Info banners auto-clear after `ttlMs ?? 4000`; errors persist until replaced
// or `Esc`-dismissed.
export interface Banner {
  readonly kind: 'info' | 'error'
  readonly text: string
  readonly ttlMs?: number
  readonly seq: number
}

interface StepsViewStateBase {
  readonly run: RunHeader
  readonly steps: readonly StepRow[]
  readonly view: ViewMode
  readonly banner?: Banner
}

export type StepsViewState =
  | ({ readonly status: 'live' } & StepsViewStateBase)
  | ({ readonly status: 'completed'; readonly summary: EndOfRunSummary } & StepsViewStateBase)
  | ({ readonly status: 'failed'; readonly summary: EndOfRunSummary } & StepsViewStateBase)
  | ({ readonly status: 'crashed'; readonly summary: EndOfRunSummary } & StepsViewStateBase)
