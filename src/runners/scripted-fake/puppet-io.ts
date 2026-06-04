/**
 * `puppet-io.ts` — the tiny shared I/O helpers for the predictable-fake entry
 * processes that `command-engine.ts` deliberately stays out of (it is pure).
 *
 * `writeAck` is the single ack-writer for BOTH entries (headless `__entry.ts`
 * and `interactive-entry.ts`): the body format (`terminate:<code>` /
 * `continue`) is the cross-process contract a driver's `waitForAck` reads, so
 * it lives in one place and cannot drift between modes. No module-import side
 * effects: exports a function only.
 */

import { writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { EngineResult } from './command-engine.ts'

/**
 * Write the per-sequence `.ack` file confirming a command was processed.
 * Body is `terminate:<code>` on a finish, `continue` otherwise. Ack failures
 * are non-fatal — the driver polls the ack dir and times out cleanly — so a
 * write error is swallowed.
 */
export async function writeAck(ackDir: string, seq: number, outcome: EngineResult): Promise<void> {
  const filePath = nodePath.join(ackDir, `${seq}.ack`)
  const body = outcome.kind === 'terminate' ? `terminate:${outcome.exitCode ?? 0}` : 'continue'
  await writeFile(filePath, body, 'utf-8').catch(() => {
    /* ack failures are non-fatal — the driver polls the ack dir and times out cleanly */
  })
}
