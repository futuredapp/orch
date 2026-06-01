// ---------------------------------------------------------------------------
// Step types — the discriminated unions consumed across the steps-view module.
// ---------------------------------------------------------------------------
//
// Hoisted out of `steps-view-model.ts` so the live-overlay + projector files
// can import the types without dragging in the factory + composition glue.

export type StepStatus = 'pending' | 'running' | 'interactive' | 'completed' | 'failed' | 'cached'

// Effective rendering depth — gutter columns to prefix in the steps view.
// 0 = root (no gutter). Optional; absent ⇔ 0. Boundary rows always carry
// `depth` explicitly. For step rows under a sub, `depth` equals the length
// of `StepEntry.subPath`. When `insideParallel` is true the projector
// resets the effective depth to 0 (R23 — parallel suppression).
export type StepDepth = number

export type StepRow =
  | {
      readonly kind: 'agent'
      readonly mode: 'autonomous'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly transcriptPath?: string
      readonly depth?: StepDepth
    }
  | {
      readonly kind: 'agent'
      readonly mode: 'interactive'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly sessionId?: string
      readonly depth?: StepDepth
      /**
       * Diagnostic name of the runner that executed this step. Persisted on
       * `StepEntry.runnerName` (interactive-only). Absent on pre-feature
       * state files; the right-pane controller uses absence as the R8
       * legacy-refusal signal.
       */
      readonly runnerName?: string
      /**
       * Captured failure mode when the runner's `captureSessionId` did not
       * yield a usable id (Codex-only today). Right-pane controller uses
       * the value to choose between R9's three refusal messages.
       */
      readonly sessionIdCaptureError?: 'ambiguous' | 'empty' | 'error'
    }
  | {
      readonly kind: 'command'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly depth?: StepDepth
    }
  | {
      readonly kind: 'commit'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
      readonly depth?: StepDepth
    }
  | {
      readonly kind: 'worktree'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
      readonly depth?: StepDepth
    }
  | {
      readonly kind: 'ask'
      readonly status: StepStatus
      readonly name: string
      readonly startedAt?: number
      readonly endedAt?: number
      readonly value: unknown
      readonly depth?: StepDepth
    }
  | {
      /**
       * Boundary row marking entry into a `runWorkflow(...)` sub. Lives only in
       * projected state (never persisted). `name` is the sub's workflow name;
       * `depth` is the sub's depth (1 for a sub directly under the parent).
       * `glyph` stays `▼` for the lifetime of the row (the active state is read
       * off the matching exit row's presence — see project-steps-view.ts).
       */
      readonly kind: 'subworkflow-enter'
      readonly name: string
      readonly depth: number
      readonly glyph: '▼'
    }
  | {
      /**
       * Boundary row marking exit from a `runWorkflow(...)` sub. Lives only in
       * projected state. `durationMs` is `undefined` for synthesized rows on
       * interrupted subs (enter fired, exit never did) — the row uses `✗` with
       * an unknown duration to bound every visible enter.
       */
      readonly kind: 'subworkflow-exit'
      readonly name: string
      readonly depth: number
      readonly glyph: '✓' | '✗'
      readonly durationMs: number | undefined
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
