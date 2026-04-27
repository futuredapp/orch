// ---------------------------------------------------------------------------
// orchLog — debug-only structured trace line.
// ---------------------------------------------------------------------------
//
// Replaces scattered `console.log` calls with a single NDJSON line written to
// `orch.log` (via the session logger's `orch` category). When `logger` is
// undefined or `logger.debug` is false, the call is a no-op — zero cost on
// baseline runs.
//
// Usage:
//   orchLog(logger, 'resolveView', { stepName, kind })
//   orchLog(logger, 'cache-hit', { stepName })

import type { JsonObject, SessionLogger } from './session-logger.ts'

export function orchLog(logger: SessionLogger | undefined, msg: string, extra?: JsonObject): void {
  if (logger === undefined || !logger.debug) return
  const record = extra === undefined ? { msg } : { msg, ...extra }
  void logger.append('orch', record).catch(() => {})
}
