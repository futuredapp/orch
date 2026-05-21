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
//   puppet           — watch a control NDJSON file and dispatch commands
//                      (test-time interactive control; behavioral cells)
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

// `puppet`: the runner subprocess opens controlPath, tails it line-by-line,
// and dispatches each NDJSON command. Commands are sent by the test via
// `handle.agent(name).*`. The runner exits on the first `complete` or `fail`.
// Pre-existing kinds (instant-ok / instant-fail / wait-for-file / emit-then-
// hang) are unchanged — puppet is strictly additive.
export const PuppetScriptSchema = z
  .object({
    kind: z.literal('puppet'),
    /**
     * Absolute path to the per-step control NDJSON file. The test launcher
     * derives this from <stateBase>/test-control/<stepName>.ndjson and writes
     * it into the script before spawn. The runner opens the file in
     * append-mode-read and tails forever.
     */
    controlPath: z.string().min(1),
    /** Poll interval for `fs.stat` size changes. Defaults to 30ms. */
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict()

export const StepScriptSchema = z.discriminatedUnion('kind', [
  InstantOkScriptSchema,
  InstantFailScriptSchema,
  WaitForFileScriptSchema,
  EmitThenHangScriptSchema,
  PuppetScriptSchema,
])

export type InstantOkScript = z.infer<typeof InstantOkScriptSchema>
export type InstantFailScript = z.infer<typeof InstantFailScriptSchema>
export type WaitForFileScript = z.infer<typeof WaitForFileScriptSchema>
export type EmitThenHangScript = z.infer<typeof EmitThenHangScriptSchema>
export type PuppetScript = z.infer<typeof PuppetScriptSchema>
export type StepScript = z.infer<typeof StepScriptSchema>

// ---------------------------------------------------------------------------
// PuppetCommand — the NDJSON command set the test writes to the control file.
// ---------------------------------------------------------------------------

const EmitCommandSchema = z
  .object({
    cmd: z.literal('emit'),
    event: RunnerEventSchema,
  })
  .strict()

const WriteFileCommandSchema = z
  .object({
    cmd: z.literal('write-file'),
    path: z.string().min(1),
    content: z.string(),
  })
  .strict()

const RunShellCommandSchema = z
  .object({
    cmd: z.literal('run-shell'),
    command: z.string().min(1),
  })
  .strict()

const CompleteCommandSchema = z
  .object({
    cmd: z.literal('complete'),
    structuredOutput: z.unknown().optional(),
  })
  .strict()

const FailCommandSchema = z
  .object({
    cmd: z.literal('fail'),
    message: z.string().min(1),
    exitCode: z.number().int().positive().optional(),
  })
  .strict()

const WaitCommandSchema = z
  .object({
    cmd: z.literal('wait'),
    ms: z.number().int().nonnegative(),
  })
  .strict()

export const PuppetCommandSchema = z.discriminatedUnion('cmd', [
  EmitCommandSchema,
  WriteFileCommandSchema,
  RunShellCommandSchema,
  CompleteCommandSchema,
  FailCommandSchema,
  WaitCommandSchema,
])

export type PuppetCommand = z.infer<typeof PuppetCommandSchema>

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
