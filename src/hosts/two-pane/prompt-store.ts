// ---------------------------------------------------------------------------
// prompt-store — always-on per-step persistence of the assembled prompt (R8).
// ---------------------------------------------------------------------------
//
// Phase 1 embeds the prompt preamble into the per-step render tee
// (`logs/agents/<step>/formatted_output.ansi`), so a replay that tails that
// frozen tee shows the prompt for free — but **only when file logging is on**.
// R8's human-reviewed contract requires the prompt to survive on an *always-on*
// path independent of the optional file logger, so a historical run renders it
// consistently with a live run even if logging was ever disabled.
//
// This module is that path. It writes the **raw** assembled prompt (no escaping,
// no marking — those happen at display time in `prompt-preamble.ts`, so a future
// display change is never a storage migration) to a deterministic per-step
// artifact rooted in the run's `stateDir`:
//
//   <stateDir>/agents/<step>/prompt.txt
//
// Crucially this is rooted in `stateDir`, **not** `logger.logsDir`: that is what
// makes R8 hold when `logsDir === null`. The prompt body is kept out of
// `state.json` (a dedicated file keeps large prompt bodies from bloating the
// run state); the replay *fallback* branch reads it back when the frozen tee is
// empty/absent. (KTD7 / plan-review F5.)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { StepName } from '../../core/types.ts'
import { type Path, path as toPath } from '../../services/types.ts'

/** Always-on writer for the per-step assembled prompt. Independent of the
 *  optional file logger; rooted in the run's `stateDir`. */
export interface PromptStore {
  /** Persist the raw assembled prompt for `step`. Idempotent per step
   *  (truncate-on-write), so a retried/fork-resumed step overwrites with the
   *  original assembled prompt (KTD5). Resolves once written. */
  write(step: StepName, prompt: string): Promise<void>
}

/** No-op store. Returned when no `stateDir` is available (pure fixtures with no
 *  basePath — those have no replay path either). */
export const NULL_PROMPT_STORE: PromptStore = {
  async write(): Promise<void> {
    /* no-op */
  },
}

/** Absolute path to a step's always-on prompt artifact under `stateDir`. */
export function promptStorePathFor(stateDir: Path, step: StepName): Path {
  return toPath(`${stateDir}/agents/${step}/prompt.txt`)
}

/**
 * Read back the raw assembled prompt persisted for `step`, or `null` when none
 * was written (older runs, non-autonomous steps, or a step that never started).
 * Used by the replay *fallback* branch only.
 */
export async function readPersistedPrompt(stateDir: Path, step: StepName): Promise<string | null> {
  try {
    return await readFile(promptStorePathFor(stateDir, step), 'utf8')
  } catch {
    return null
  }
}

/** Create an always-on prompt store rooted in `stateDir`. */
export function createPromptStore(stateDir: Path): PromptStore {
  return {
    async write(step: StepName, prompt: string): Promise<void> {
      const dir = toPath(`${stateDir}/agents/${step}`)
      await mkdir(dir, { recursive: true })
      await writeFile(promptStorePathFor(stateDir, step), prompt, 'utf8')
    },
  }
}
