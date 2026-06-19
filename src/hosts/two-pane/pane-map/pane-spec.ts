// ---------------------------------------------------------------------------
// pane-spec — the discriminated-union types that key the pane map.
// ---------------------------------------------------------------------------
//
// A `SourceKey` identifies one logical "source of bytes" the right pane can
// show — a live autonomous transcript, a frozen replay of a completed step,
// an aggregated parallel rollup, an interactive runner PTY, or the always-
// present placeholder. The pane map (`Map<SourceKey, PaneId>`) records which
// hidden pane in the scratch tmux session is currently rendering each source.
//
// `PaneSpec` describes how to spawn the hidden pane for a given source. Two
// archetypes:
//   - `file-tail`: spawn `tail -n 5000 -F <path>` in a hidden pane; the path's
//     bytes appear in the pane (live for an open tee, frozen for a closed
//     one).
//   - `pty`: spawn `<argv...>` in a hidden pane with optional env/cwd; the
//     pane is a real PTY for the runner.
//
// The Map keys on a deterministic string serialization of `SourceKey` so
// structural equality works. `sourceKeyToString` is the single source of
// truth for that serialization.

import type { StepName } from '../../../core/types.ts'
import type { Path } from '../../../services/types.ts'

/**
 * The kind of process that runs in a hidden pane.
 *
 * `file-tail` covers every byte-stream source — live autonomous, command
 * step live, completed replays, rollup, kind-details, placeholder. The host
 * writes bytes to the tee file; the pane's `tail -F` mirrors them.
 *
 * `pty` covers interactive runners only — the pane runs the runner argv
 * directly, so stdin/stdout/resize/colors all flow natively.
 */
export type PaneSpec =
  | {
      readonly kind: 'file-tail'
      readonly path: Path
      /**
       * Read the file from its first line (`tail -n +1 -F`) instead of the
       * bounded `tail -n 5000 -F` backfill window. Set for prompt-bearing
       * sources (autonomous live + replay) so a prompt+output stream longer
       * than the backfill window keeps its head — the `prompt:` preamble — on
       * screen (R2/AT-5 "no truncation", AT-9 "open at top of prompt"). Omitted
       * ⇔ the default bounded tail (every other byte-stream source).
       */
      readonly fromStart?: boolean
    }
  | {
      readonly kind: 'pty'
      readonly argv: readonly string[]
      readonly env?: Readonly<Record<string, string>>
      readonly cwd?: Path
    }

/**
 * The logical identity of a source the right pane can show.
 *
 * - `live`: an autonomous or command-step transcript that's currently running.
 * - `replay`: a frozen transcript for a completed step (warm-cached).
 * - `rollup`: the aggregated parallel-branch summary.
 * - `interactive`: an interactive-runner PTY pane.
 * - `placeholder`: the always-present blank pane (tail -F /dev/null).
 *
 * `live` is the only variant the controller transforms — on `step:complete`
 * a `{type:'live', stepName}` source is rekeyed to `{type:'replay', stepName}`
 * without killing the hidden pane (warm cache).
 */
export type SourceKey =
  | { readonly type: 'live'; readonly stepName: StepName }
  | { readonly type: 'replay'; readonly stepName: StepName }
  | { readonly type: 'rollup' }
  | { readonly type: 'interactive'; readonly stepName: StepName }
  | { readonly type: 'placeholder' }

/**
 * Deterministic string serialization of a `SourceKey` for `Map` keying.
 * Structural equality across calls — two `SourceKey` instances with the same
 * fields serialize to the same string.
 */
export const sourceKeyToString = (key: SourceKey): string => {
  switch (key.type) {
    case 'live':
      return `live:${key.stepName}`
    case 'replay':
      return `replay:${key.stepName}`
    case 'interactive':
      return `interactive:${key.stepName}`
    case 'rollup':
      return 'rollup'
    case 'placeholder':
      return 'placeholder'
  }
}
