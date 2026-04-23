// ---------------------------------------------------------------------------
// Transcript sidecar — append-only NDJSON per step, one event per line.
// ---------------------------------------------------------------------------
//
// Why a sidecar: `state.json` does a full read-modify-write on every
// `saveStep()`. Storing RunnerEvents inline would rewrite MBs per event on
// long runs. The sidecar is append-only; `state.json` keeps a pointer +
// event count + truncation flag, so the hot write path touches one small
// file and one small append.
//
// Crash tolerance: a partially-written line is one discarded event, not a
// corrupt file. Each call writes `JSON.stringify(event) + '\n'` atomically
// enough for NDJSON consumers — readers skip malformed lines.
//
// Parallel safety: each step has its own file, so two parallel branches
// never write to the same sidecar. No per-file locking needed.

import type { FsService } from '../services/fs/fs-service.ts'
import type { Path } from '../services/types.ts'
import { path } from '../services/types.ts'
import type { RunId } from './run-id.ts'

/**
 * Per-step handle returned by `TranscriptSidecar.forStep`. The handle
 * maintains an append position + event count; call `append` for each
 * RunnerEvent, then `snapshot()` to read `{path, count}` for the StepEntry.
 */
export interface StepTranscript {
  /** Append one event to the step's sidecar file. Idempotent on I/O errors —
   *  the caller gets the rejection, and the count does not advance. */
  append(event: unknown): Promise<void>
  /**
   * Pointer + count at the time of the call. Safe to read after every
   * `append` resolves. The path is relative to `.orch/state/<runId>/` so
   * state.json stays portable across machine moves.
   */
  snapshot(): { readonly transcriptPath: string; readonly transcriptEventCount: number }
}

export interface TranscriptSidecar {
  /** Returns a handle for the given step name. Safe to call multiple times
   *  per step — the same handle shape is returned each call (fresh count). */
  forStep(stepName: string): StepTranscript
}

export interface CreateTranscriptSidecarDeps {
  readonly fs: FsService
  readonly runId: RunId
  /** The `.orch/state` directory root. The sidecar writes under
   *  `<basePath>/<runId>/steps/<name>.transcript.ndjson`. */
  readonly basePath: Path
}

export function createTranscriptSidecar(deps: CreateTranscriptSidecarDeps): TranscriptSidecar {
  const runDir = path(`${deps.basePath}/${deps.runId}`)
  const stepsDir = path(`${runDir}/steps`)
  let stepsDirEnsured: Promise<void> | undefined

  // Lazy mkdir — many runs never emit events (commit-only, interactive-only
  // workflows), and we don't want to create an empty `steps/` for them.
  const ensureStepsDir = (): Promise<void> => {
    if (stepsDirEnsured === undefined) {
      stepsDirEnsured = deps.fs.mkdir(stepsDir, { recursive: true })
    }
    return stepsDirEnsured
  }

  const handles = new Map<string, StepTranscript>()

  return {
    forStep(stepName: string): StepTranscript {
      const cached = handles.get(stepName)
      if (cached !== undefined) return cached

      const relativePath = `steps/${sanitizeStepName(stepName)}.transcript.ndjson`
      const filePath = path(`${runDir}/${relativePath}`)
      let count = 0
      // Per-step serial append chain prevents two concurrent RunnerEvent
      // callbacks from interleaving lines in the sidecar file.
      let chain: Promise<void> = Promise.resolve()

      const handle: StepTranscript = {
        async append(event: unknown): Promise<void> {
          const line = `${JSON.stringify(event)}\n`
          const next = chain.then(async () => {
            await ensureStepsDir()
            await deps.fs.appendFile(filePath, line)
            count += 1
          })
          // Swallow on the chain so a failing write doesn't poison later
          // appends. The awaited promise still rejects for the caller.
          chain = next.catch(() => {})
          await next
        },
        snapshot(): { readonly transcriptPath: string; readonly transcriptEventCount: number } {
          return { transcriptPath: relativePath, transcriptEventCount: count }
        },
      }

      handles.set(stepName, handle)
      return handle
    },
  }
}

/**
 * Guard against step names that would collide with path separators or
 * escape the sidecar directory. Step names are already `stepName()`-branded
 * elsewhere (strict charset) but sanitizing here keeps the writer robust
 * against internal callers that pass raw strings.
 */
function sanitizeStepName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
