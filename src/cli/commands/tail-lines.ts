// `tailLines` — the inline tail-loop helper used by `orch logs --follow`.
//
// Plan AD-10: the tail logic lives outside the FsService port. Orch writes
// the transcript file append-only and never rotates it, so a monotonically-
// increasing offset is enough — no inode tracking, no truncation detection,
// no `maxBytesPerTick` knob.
//
// Split out of `logs.ts` for the file-size budget (CLAUDE.md rule 5: files
// ≤ 300 lines). Imported back into `logs.ts` and exported from there too so
// the existing tail-lines unit test keeps its API surface.

import type { Path } from '../../services/types.ts'

const TICK_MS = 100

export async function* tailLines(filePath: Path, signal: AbortSignal): AsyncIterable<string> {
  let offset = 0
  let pending = ''

  while (!signal.aborted) {
    let chunk = ''
    try {
      chunk = await Bun.file(filePath).slice(offset).text()
    } catch {
      // File may not exist yet — the transcript writer creates it on first
      // append. Loop and try again next tick.
      chunk = ''
    }
    if (chunk.length > 0) {
      offset += Buffer.byteLength(chunk)
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) yield line
    }
    if (signal.aborted) break
    await Bun.sleep(TICK_MS)
  }

  if (pending.length > 0) yield pending
}
