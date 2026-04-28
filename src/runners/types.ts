import { z } from 'zod'
import type { ViewDefault } from '../core/view.ts'
import type { Path } from '../services/types.ts'

// ---------------------------------------------------------------------------
// RunnerContext — the input bag every runner receives
// ---------------------------------------------------------------------------

export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs: readonly string[]
  readonly schema?: { readonly jsonSchema: string }
  readonly mode?: 'interactive' | 'autonomous'
  /** Session ID for interactive steps. Passed via --session-id. */
  readonly sessionId?: string
}

// ---------------------------------------------------------------------------
// Events — two-level discriminated union (kind + type)
//
// Without `kind`, TS structural subtyping collapses RunnerEvent to InfoEvent
// because InfoEvent.type is `string` which subsumes TerminalEvent.type literals.
// Verified empirically with tsc 6.0.2 --strict --noUncheckedIndexedAccess.
// ---------------------------------------------------------------------------

export type TerminalEvent =
  | { readonly kind: 'terminal'; readonly type: 'turn-complete'; readonly data?: unknown }
  | {
      readonly kind: 'terminal'
      readonly type: 'error'
      readonly message: string
      readonly data?: unknown
    }

export interface InfoEvent {
  readonly kind: 'info'
  readonly type: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export type RunnerEvent = TerminalEvent | InfoEvent

export function isTerminalEvent(e: RunnerEvent): e is TerminalEvent {
  return e.kind === 'terminal'
}

// ---------------------------------------------------------------------------
// TranscriptLine — runner-formatted, host-rendered.
//
// Runners pre-format every RunnerEvent into zero-or-more TranscriptLines.
// Hosts map `category` to glyph/color (presentation policy) and add the
// `[<step>] ` prefix; runners stay free of ANSI and pane-width concerns.
// `kind: 'block'` carries multi-line completion/failure summaries.
// ---------------------------------------------------------------------------

export type TranscriptCategory =
  | 'system'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'tool-error'
  | 'assistant'

export type TranscriptLine =
  | {
      readonly kind: 'line'
      readonly category: TranscriptCategory
      readonly label?: string
      readonly body: string
    }
  | {
      readonly kind: 'block'
      readonly heading: 'done' | 'failed'
      readonly rows: ReadonlyArray<readonly [label: string, value: string]>
    }

// ---------------------------------------------------------------------------
// RunnerCommand — return type of buildCommand
// ---------------------------------------------------------------------------

export interface RunnerCommand {
  readonly argv: readonly string[]
  /** Full replacement — passed directly to ProcessService. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Runner — the port every CLI adapter implements
// ---------------------------------------------------------------------------

export interface Runner {
  readonly name: string
  readonly supports: { readonly interactive: boolean; readonly structuredOutput: boolean }
  /**
   * What view + pane this runner declares for autonomous steps by default.
   * Optional so third-party runners written against the Phase 1 interface
   * stay source-compatible; the layered resolver in core falls back to
   * `{ kind: 'transcript', pane: 'right' }` when absent.
   */
  readonly defaultView?: ViewDefault
  /**
   * Build the CLI argv + env for this runner. May return a Promise when the
   * adapter needs async preparation (e.g. writing a temp schema file).
   * Consumers must always `await` the result.
   */
  buildCommand(ctx: RunnerContext): RunnerCommand | Promise<RunnerCommand>
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent): unknown
  /**
   * Format a `RunnerEvent` for the human-readable transcript stream.
   * Return `[]` to suppress the event entirely (e.g. `rate_limit_event`).
   *
   * Pure: no I/O, no external state. Called synchronously by the executor
   * before the event reaches the host. A throw is caught by the executor and
   * logged once; the event is still persisted to disk via the JSON path.
   */
  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
}

// ---------------------------------------------------------------------------
// defineRunner — validating identity factory
//
// Uses safeParse to avoid leaking config values in error messages (S7).
// Returns the original config frozen — not Zod's inferred output — to
// preserve the caller's literal type T.
// ---------------------------------------------------------------------------

const RunnerAdapterSchema = z.object({
  name: z.string().min(1),
  supports: z.object({
    interactive: z.boolean(),
    structuredOutput: z.boolean(),
  }),
  // View kind stays a bare string at the schema layer so v2 plugins that widen
  // `ViewKindRegistry` via interface augmentation can ship custom kinds
  // without editing core; pane is locked to the two v1 slots.
  defaultView: z
    .object({
      kind: z.string().min(1),
      pane: z.enum(['left', 'right']),
    })
    .optional(),
  buildCommand: z.custom<Runner['buildCommand']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
  parseEvents: z.custom<Runner['parseEvents']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
  extractStructuredOutput: z.custom<Runner['extractStructuredOutput']>(
    (v) => typeof v === 'function',
    { message: 'expected function' },
  ),
  toTranscriptLines: z.custom<Runner['toTranscriptLines']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
})

export function defineRunner<T extends Runner>(config: T): Readonly<T> {
  const result = RunnerAdapterSchema.safeParse(config)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`defineRunner: invalid runner config (fields: ${fields})`)
  }
  return Object.freeze(config)
}
