import type { Path } from '../services/types.ts'

// ---------------------------------------------------------------------------
// RunnerContext — the input bag every runner receives
// ---------------------------------------------------------------------------

export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs: readonly string[]
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
// RunnerCommand — return type of buildCommand
// ---------------------------------------------------------------------------

export interface RunnerCommand {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Runner — the port every CLI adapter implements
// ---------------------------------------------------------------------------

export interface Runner {
  readonly name: string
  readonly supports: { readonly interactive: boolean; readonly structuredOutput: boolean }
  buildCommand(ctx: RunnerContext): RunnerCommand
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent): unknown
}

// ---------------------------------------------------------------------------
// defineRunner — validating identity factory
// ---------------------------------------------------------------------------

export function defineRunner<T extends Runner>(_config: T): Readonly<T> {
  throw new Error('not implemented')
}
