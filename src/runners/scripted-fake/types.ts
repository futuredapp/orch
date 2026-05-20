/**
 * `ScriptedFakeRunner` types — discriminated union of per-step behaviors and
 * the cross-process script-file shape.
 *
 * The Tier 5 behavioral harness (tests/helpers/behavioral-dsl/) writes a
 * JSON file matching `ScriptedFakeScriptFile` and points the orch subprocess
 * at it via `ORCH_LIFECYCLE_SCRIPT`. The runner's per-step entry process
 * (src/runners/scripted-fake/__entry.ts) reads that file, looks up its step
 * name, and drives the matching script.
 *
 * The schema lives next to the runner (not the harness) so it is the single
 * source of truth on both sides of the process boundary.
 */

import { z } from 'zod'
import type { RunnerEvent } from '../types.ts'

// ---------------------------------------------------------------------------
// RunnerEvent shapes (relaxed Zod) — must round-trip JSON.parse from arbitrary
// fixture-author payloads. The runner trusts whatever shape the script author
// supplied; downstream `parseEvents` validates per-event semantics.
// ---------------------------------------------------------------------------

const RunnerEventSchema: z.ZodType<RunnerEvent> = z.union([
  z
    .object({
      kind: z.literal('terminal'),
      type: z.literal('turn-complete'),
      data: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('terminal'),
      type: z.literal('error'),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('info'),
      type: z.string().min(1),
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]) as z.ZodType<RunnerEvent>

// ---------------------------------------------------------------------------
// StepScript — discriminated union per plan §Key Technical Decisions.
//
//   instant-ok       — emit scripted events, then turn-complete, exit 0
//   instant-fail     — emit a terminal/error event, exit 1
//   wait-for-file    — poll for the named file, then emit + exit 0
//   emit-then-hang   — emit scripted events then sleep until killed
// ---------------------------------------------------------------------------

export const InstantOkScriptSchema = z
  .object({
    kind: z.literal('instant-ok'),
    events: z.array(RunnerEventSchema).optional(),
    structuredOutput: z.unknown().optional(),
  })
  .strict()

export const InstantFailScriptSchema = z
  .object({
    kind: z.literal('instant-fail'),
    message: z.string().min(1),
    exitCode: z.number().int().positive().optional(),
  })
  .strict()

export const WaitForFileScriptSchema = z
  .object({
    kind: z.literal('wait-for-file'),
    gatePath: z.string().min(1),
    events: z.array(RunnerEventSchema).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict()

export const EmitThenHangScriptSchema = z
  .object({
    kind: z.literal('emit-then-hang'),
    events: z.array(RunnerEventSchema),
  })
  .strict()

export const StepScriptSchema = z.discriminatedUnion('kind', [
  InstantOkScriptSchema,
  InstantFailScriptSchema,
  WaitForFileScriptSchema,
  EmitThenHangScriptSchema,
])

export type InstantOkScript = z.infer<typeof InstantOkScriptSchema>
export type InstantFailScript = z.infer<typeof InstantFailScriptSchema>
export type WaitForFileScript = z.infer<typeof WaitForFileScriptSchema>
export type EmitThenHangScript = z.infer<typeof EmitThenHangScriptSchema>
export type StepScript = z.infer<typeof StepScriptSchema>

// ---------------------------------------------------------------------------
// ScriptedFakeScriptFile — the JSON the harness writes to disk.
//
// Top-level shape is `{ steps: Record<StepName, StepScript> }`. Wrapping in
// `steps` (instead of a bare map) leaves room for future top-level fields
// (e.g. a default-script, a `version` discriminant) without breaking
// loaders.
// ---------------------------------------------------------------------------

export const ScriptedFakeScriptFileSchema = z
  .object({
    steps: z.record(z.string().min(1), StepScriptSchema),
  })
  .strict()

export type ScriptedFakeScriptFile = z.infer<typeof ScriptedFakeScriptFileSchema>

/** Env var name the runner reads to locate the script JSON file. */
export const ORCH_LIFECYCLE_SCRIPT_ENV = 'ORCH_LIFECYCLE_SCRIPT'
