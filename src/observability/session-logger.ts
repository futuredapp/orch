// ---------------------------------------------------------------------------
// SessionLogger — sole observability port for per-run session logging.
// ---------------------------------------------------------------------------
//
// Every writer that wants to emit into `.orch/state/<runId>/logs/` goes
// through this port. The file-backed adapter (`createFileSessionLogger`) is
// the production path; the null adapter (`createNullSessionLogger`) is the
// zero-cost default for tests and for callers that don't care about logs.
//
// The port is intentionally narrow: append a record to a category, write a
// whole file, open a raw byte sink (debug-only), close the logger. The step
// span handle auto-tags stepName + stepSpanId + ts so writers stay terse.

import type { StepName } from '../core/types.ts'
import type { Path } from '../services/types.ts'
import type { RunId } from '../state/index.ts'

// ---------------------------------------------------------------------------
// Log categories — one file per category; `timeline.ndjson` is the mirror.
// ---------------------------------------------------------------------------

export type LogCategory = 'spawns' | 'events' | 'lifecycle' | 'subprocesses' | 'orch'

export type JsonObject = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// StepSpanId — UUID minted per step attempt; fans out across every log file.
// ---------------------------------------------------------------------------

export type StepSpanId = string & { readonly __brand: 'StepSpanId' }

export function stepSpanId(s: string): StepSpanId {
  if (s.length === 0) throw new Error('stepSpanId: empty string is not a valid id')
  return s as StepSpanId
}

// ---------------------------------------------------------------------------
// StepSpan — returned by `forStep`; auto-tags records on append.
// ---------------------------------------------------------------------------

export interface StepSpan {
  readonly stepSpanId: StepSpanId
  readonly stepName: StepName
  /** Auto-tags `stepName` + `stepSpanId` + `ts` onto the record, then
   *  delegates to the parent append. Also mirrors into `timeline.ndjson`. */
  append(category: LogCategory, record: JsonObject): Promise<void>
}

// ---------------------------------------------------------------------------
// RawSink — debug-only byte pipe (agent stdout/stderr, tmux pipe-pane).
// ---------------------------------------------------------------------------

export interface RawSink {
  write(chunk: Uint8Array | string): Promise<void>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// SessionLogger — the port.
// ---------------------------------------------------------------------------

export interface SessionLogger {
  readonly runId: RunId
  readonly debug: boolean
  /**
   * Absolute path to `<basePath>/<runId>/logs/`. Exposed so callers that
   * must write outside the logger's own writer (e.g. `tmux pipe-pane`, which
   * tees pane bytes via `/bin/sh -c`) can compute a target path under the
   * run's log directory. `null` on the null adapter — consumers should no-op
   * when absent.
   */
  readonly logsDir: Path | null
  /** Non-step-scoped append (run-level events like `run-ended`). Also mirrors
   *  into `timeline.ndjson`. */
  append(category: LogCategory, record: JsonObject): Promise<void>
  /** Create a step span with a fresh `stepSpanId`. Safe to call once per
   *  step attempt; the handle is cheap. */
  forStep(stepName: StepName): StepSpan
  /** Write a complete file under logs/ (run.meta.json, README.md,
   *  agents/<name>.session.json). Writes atomically via tmp + rename. */
  writeFile(relPath: string, body: string): Promise<void>
  /** `--debug` raw byte sink for `agents/<name>.stdout` / `.stderr` /
   *  `tmux/<paneId>.log` / `orch.log`. Returns `null` when `!debug` so
   *  callers can no-op without branching on `debug`. */
  rawSink(relPath: string): RawSink | null
  /** Flush any in-flight appends. Called from teardown paths. */
  close(): Promise<void>
}
