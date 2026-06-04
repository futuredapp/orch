// Shared durable-render-oracle helpers for the predictable-fake real-tmux
// acceptance tests (F1, F2).
//
// A headless step's output lands in its per-step `formatted_output.txt` tee
// (ANSI-stripped) regardless of which pane is live at teardown, so both F1 and
// F2 gate their headless assertions on that file rather than scraping a pane
// (Tier-5 findings). These two helpers were byte-duplicated across the two test
// files; they live here so the path layout and the poll deadline cannot drift.

import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'

/** Poll deadline for `readWhenContains` — the durable tee should appear well within this. */
export const TEE_READ_TIMEOUT_MS = 5_000

const TEE_POLL_MS = 25

/** The per-step headless formatted-output tee path under a run's state dir. */
export function teeTxt(runDir: string, key: string): string {
  return nodePath.join(runDir, 'logs', 'agents', key, 'formatted_output.txt')
}

/** Resolve with the file body once it contains `needle`; throw on timeout. */
export async function readWhenContains(path: string, needle: string): Promise<string> {
  const deadline = Date.now() + TEE_READ_TIMEOUT_MS
  for (;;) {
    const body = await readFile(path, 'utf-8').catch(() => '')
    if (body.includes(needle)) return body
    if (Date.now() >= deadline) {
      throw new Error(`readWhenContains: ${path} never contained ${JSON.stringify(needle)}`)
    }
    await new Promise((r) => setTimeout(r, TEE_POLL_MS))
  }
}
