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

export type StepsViewState =
  | { readonly status: 'live'; readonly run: RunHeader; readonly steps: readonly StepRow[] }
  | {
      readonly status: 'completed'
      readonly run: RunHeader
      readonly steps: readonly StepRow[]
      readonly summary: EndOfRunSummary
    }
  | {
      readonly status: 'failed'
      readonly run: RunHeader
      readonly steps: readonly StepRow[]
      readonly summary: EndOfRunSummary
    }
  | {
      readonly status: 'crashed'
      readonly run: RunHeader
      readonly steps: readonly StepRow[]
      readonly summary: EndOfRunSummary
    }
