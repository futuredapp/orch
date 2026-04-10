import { z } from 'zod'
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
})

export function defineRunner<T extends Runner>(config: T): Readonly<T> {
  const result = RunnerAdapterSchema.safeParse(config)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`defineRunner: invalid runner config (fields: ${fields})`)
  }
  return Object.freeze(config)
}
