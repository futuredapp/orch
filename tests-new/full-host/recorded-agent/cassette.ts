// ---------------------------------------------------------------------------
// RecordedAgentCassette (D9 / parent §5.6) — OUR normalised RunnerEvent stream.
// ---------------------------------------------------------------------------
//
// A cassette captures the Runner's NORMALISED event stream (via the `onEvent`
// tap), never raw CLI stdout — so it cannot drift with CLI output formatting,
// and it never re-tests the runner parser (raw parser fixtures stay at the
// runner layer, §5.6/D9).
//
// The stream is SPLIT into `events` (streamed `InfoEvent`s) + a single
// `terminal` outcome because `FakeRunner.script()` takes `readonly InfoEvent[]`
// and SYNTHESIZES its own terminal from `structuredOutput`/`failWith` — a flat
// `RunnerEvent[]` would type-error on the terminal element and double the
// terminal on replay (verified against `src/runners/fake/fake-runner.ts`;
// D-P3.1). `cassetteToScript` maps the split back into a `FakeScript`.

import { z } from 'zod'
import type { FakeScript, InfoEvent, TerminalEvent } from '../../../src/runners/index.ts'

// --- schema (validates a cassette read off disk; D9) ------------------------

const InfoEventSchema = z.object({
  kind: z.literal('info'),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const TerminalEventSchema = z.discriminatedUnion('type', [
  z.object({
    kind: z.literal('terminal'),
    type: z.literal('turn-complete'),
    data: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('terminal'),
    type: z.literal('error'),
    message: z.string(),
    data: z.unknown().optional(),
  }),
])

export const RecordedAgentCassetteSchema = z.object({
  schemaVersion: z.literal(1),
  runner: z.enum(['claude', 'codex']),
  runnerVersion: z.string().optional(),
  recordedAt: z.string(),
  sourceCommand: z.array(z.string()).readonly(),
  workflowName: z.string(),
  scenarioId: z.string(),
  prompt: z.string(),
  eventSchema: z.literal('RunnerEvent'),
  events: z.array(InfoEventSchema).readonly(),
  terminal: TerminalEventSchema,
})

export interface RecordedAgentCassette {
  readonly schemaVersion: 1
  readonly runner: 'claude' | 'codex'
  readonly runnerVersion?: string
  readonly recordedAt: string
  readonly sourceCommand: readonly string[]
  readonly workflowName: string
  readonly scenarioId: string
  readonly prompt: string
  readonly eventSchema: 'RunnerEvent'
  /** Streamed info events (kind:'info'), captured via the onEvent tap. */
  readonly events: readonly InfoEvent[]
  /** The single terminal outcome, captured separately. */
  readonly terminal: TerminalEvent
}

// --- validation -------------------------------------------------------------

/** Parse + validate untrusted JSON into a typed cassette, or throw with the
 *  offending field paths (mirrors `defineRunner`'s safe-parse discipline). */
export function parseCassette(raw: unknown): RecordedAgentCassette {
  const result = RecordedAgentCassetteSchema.safeParse(raw)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.') || '<root>').join(', ')
    throw new Error(`invalid cassette (fields: ${fields})`)
  }
  // The Zod output is structurally the cassette; the cast restores the literal
  // event types the schema widens (`unknown` data, generic record payload).
  return result.data as RecordedAgentCassette
}

// --- replay shim (cassette → FakeScript) ------------------------------------

/**
 * Map a cassette's split `{ events, terminal }` onto the shape
 * `FakeRunner.script` consumes: a `turn-complete` terminal becomes
 * `structuredOutput`; an `error` terminal becomes `failWith` (D-P3.1).
 */
export function cassetteToScript(c: RecordedAgentCassette): FakeScript {
  if (c.terminal.type === 'error') {
    return { events: c.events, failWith: { message: c.terminal.message } }
  }
  return { events: c.events, structuredOutput: c.terminal.data }
}

// --- deterministic serializer (stable bytes; re-record is reproducible) -----

/** JSON with recursively sorted object keys — byte-stable across runs. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Serialize a cassette deterministically (sorted keys + trailing newline). */
export function serializeCassette(c: RecordedAgentCassette): string {
  return `${stableStringify(c)}\n`
}
