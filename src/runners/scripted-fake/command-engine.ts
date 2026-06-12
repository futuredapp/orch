/**
 * `command-engine.ts` — the single command engine shared by both fake modes.
 *
 * The predictable fake accepts commands from two channels (the puppet NDJSON
 * control file and manual stdin) and runs in two modes (headless = NDJSON
 * events on stdout; interactive = an Ink/TTY render). R1 says the modes differ
 * *only* in how output reaches the right pane, so the vocabulary, the finish
 * semantics, and the channel-agnostic parsing all live here, and the one
 * mode-specific piece is injected as an `OutputSink`.
 *
 * Vocabulary (R2):
 *   - `type_and_send(text)` — append one line of output.
 *   - `finish(code?)`       — end the step with an optional exit/result code.
 *   - `fail(message, code)` — end the step with a SIMULATED failure: emit a
 *     terminal/error and exit non-zero so the step lands `failed` in both modes.
 *
 * Both channels converge on the same `EngineOp` (R3/R4/R5):
 *   - control NDJSON `{ cmd: 'type_and_send', text }` / `{ cmd: 'finish', code? }`
 *     / `{ cmd: 'fail', message, exitCode? }`
 *   - manual line: a bare line is `type_and_send(line)`; literal `q`/`exit` is
 *     `finish`; literal `fail` is `fail`.
 *
 * Pure: no I/O of its own. The caller supplies the `OutputSink`; `runEngineOp`
 * only routes. This keeps the engine identical across modes and trivially
 * unit-testable with a recording sink.
 */

import { type PuppetCommand, PuppetCommandSchema } from './types.ts'

// ---------------------------------------------------------------------------
// EngineOp — the normalized two-op vocabulary both channels map onto.
// ---------------------------------------------------------------------------

/** Default exit code for a simulated failure when the source carries none. */
export const DEFAULT_FAIL_CODE = 1
/** Default message for a manually-triggered (`fail` keyword) failure. */
export const DEFAULT_FAIL_MESSAGE = 'simulated failure'

export type EngineOp =
  | { readonly op: 'type_and_send'; readonly text: string }
  | { readonly op: 'finish'; readonly code: number }
  | { readonly op: 'fail'; readonly code: number; readonly message: string }

/** Whether the loop continues or terminates, plus the exit code on finish. */
export interface EngineResult {
  readonly kind: 'continue' | 'terminate'
  readonly exitCode?: number
}

/**
 * The one mode-specific dependency. Headless injects "emit an NDJSON info
 * event + write the terminal event"; interactive injects "render the line into
 * the TUI + let the process exit on finish". The engine never knows which.
 */
export interface OutputSink {
  /** Append exactly one line of agent output to the right pane. */
  typeLine(text: string): void
  /**
   * Perform the mode-specific terminal action. Headless writes the NDJSON
   * terminal event (turn-complete for 0, error otherwise); interactive lets
   * the process exit so the host's `pane-died` advances the workflow.
   */
  finish(code: number): void
  /**
   * Perform the mode-specific SIMULATED-failure terminal action. Headless
   * writes a terminal/error event; interactive records the error to the render
   * log and exits non-zero so the host's recovered exit code marks the step
   * `failed`. `code` is always non-zero.
   */
  fail(message: string, code: number): void
}

// ---------------------------------------------------------------------------
// runEngineOp — apply a normalized op to the injected sink.
// ---------------------------------------------------------------------------

export function runEngineOp(op: EngineOp, sink: OutputSink): EngineResult {
  switch (op.op) {
    case 'type_and_send':
      // Empty output is a no-op in BOTH modes so headless (which renders only
      // non-empty info text) and interactive (which would otherwise show a
      // blank line) stay identical — preserving R3.
      if (op.text.length > 0) sink.typeLine(op.text)
      return { kind: 'continue' }
    case 'finish':
      sink.finish(op.code)
      return { kind: 'terminate', exitCode: op.code }
    case 'fail':
      sink.fail(op.message, op.code)
      return { kind: 'terminate', exitCode: op.code }
  }
}

// ---------------------------------------------------------------------------
// Manual stdin parsing (R5) — interactive mode only.
// ---------------------------------------------------------------------------

const QUIT_WORDS = new Set(['q', 'exit'])
const FAIL_WORDS = new Set(['fail'])

/**
 * Parse one manual input line into an `EngineOp`, or `null` when the line
 * produces no op (empty / whitespace-only — see the R3 empty-line decision in
 * `runEngineOp`).
 *
 * The reserved-word checks and emptiness test run against the trimmed line, so
 * `q ` (trailing space) is `finish`, `fail ` is `fail`, and a whitespace-only
 * line is ignored. A non-reserved line keeps its exact text (interior/leading
 * spaces preserved) so what the user typed is what renders.
 */
export function parseManualLine(raw: string): EngineOp | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (QUIT_WORDS.has(trimmed)) return { op: 'finish', code: 0 }
  if (FAIL_WORDS.has(trimmed)) {
    return { op: 'fail', code: DEFAULT_FAIL_CODE, message: DEFAULT_FAIL_MESSAGE }
  }
  return { op: 'type_and_send', text: raw }
}

// ---------------------------------------------------------------------------
// Control-channel parsing (R4) — shared by headless and interactive.
// ---------------------------------------------------------------------------

export type ControlParseResult =
  | { readonly kind: 'ok'; readonly value: PuppetCommand }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Parse one NDJSON control-file line into a `PuppetCommand`. Malformed JSON and
 * schema mismatches are returned as `{ kind: 'error' }` rather than thrown, so
 * the driving loop can surface a clean terminal/error instead of crashing
 * (mirrors the prior `safeParse` behavior this function replaces).
 */
export function parseControlLine(line: string): ControlParseResult {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'error', message: `invalid JSON (${reason})` }
  }
  const parsed = PuppetCommandSchema.safeParse(json)
  if (!parsed.success) {
    const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { kind: 'error', message: `schema (${summary})` }
  }
  return { kind: 'ok', value: parsed.data }
}

/**
 * Map a control command to a normalized `EngineOp` for the cross-mode
 * vocabulary, or `null` for the legacy headless-only commands
 * (`emit` / `write-file` / `run-shell` / `complete` / `wait`) the entry keeps
 * dispatching directly for backward compatibility.
 *
 * `fail` is cross-mode: routing it through the engine gives both modes one
 * `fail` op (headless emits the same terminal/error it always did; interactive
 * gains the ability to land `failed`), so it is mapped here rather than left to
 * the headless-only switch.
 */
export function controlToEngineOp(command: PuppetCommand): EngineOp | null {
  switch (command.cmd) {
    case 'type_and_send':
      return { op: 'type_and_send', text: command.text }
    case 'finish':
      return { op: 'finish', code: command.code ?? 0 }
    case 'fail':
      return { op: 'fail', code: command.exitCode ?? DEFAULT_FAIL_CODE, message: command.message }
    default:
      return null
  }
}
