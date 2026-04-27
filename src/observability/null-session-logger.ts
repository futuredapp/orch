// ---------------------------------------------------------------------------
// NullSessionLogger — zero-cost no-op adapter.
// ---------------------------------------------------------------------------
//
// Returned by `createDeps` when the caller has no interest in logs (pure unit
// tests, tools that only use the state store). Every method resolves without
// touching disk. `rawSink` returns null so `--debug` gates stay a single
// truthiness check at the call site.

import { randomUUID } from 'node:crypto'
import type { StepName } from '../core/types.ts'
import type { RunId } from '../state/index.ts'
import { runId as runIdFactory } from '../state/index.ts'
import type {
  JsonObject,
  LogCategory,
  SessionLogger,
  StepSpan,
  StepSpanId,
} from './session-logger.ts'
import { stepSpanId as stepSpanIdFactory } from './session-logger.ts'

const PLACEHOLDER_RUN_ID = runIdFactory('r-1970-01-01-000000')

export interface CreateNullSessionLoggerOptions {
  readonly runId?: RunId
  readonly debug?: boolean
}

export function createNullSessionLogger(opts: CreateNullSessionLoggerOptions = {}): SessionLogger {
  const resolvedRunId = opts.runId ?? PLACEHOLDER_RUN_ID
  const debug = opts.debug ?? false

  return {
    runId: resolvedRunId,
    debug,
    logsDir: null,
    async append(_category: LogCategory, _record: JsonObject): Promise<void> {
      /* no-op */
    },
    forStep(name: StepName): StepSpan {
      const spanId = stepSpanIdFactory(randomUUID())
      return {
        stepSpanId: spanId,
        stepName: name,
        async append(_category: LogCategory, _record: JsonObject): Promise<void> {
          /* no-op */
        },
      }
    },
    async writeFile(_relPath: string, _body: string): Promise<void> {
      /* no-op */
    },
    rawSink(_relPath: string): null {
      return null
    },
    async close(): Promise<void> {
      /* no-op */
    },
  }
}

// Re-export the span id type so callers importing from this file stay tidy.
export type { StepSpanId }
