// ---------------------------------------------------------------------------
// replay-command-pane — pure renderer that resolves the source for a
// `command:` step's replay payload.
// ---------------------------------------------------------------------------
//
// `--debug` runs install `tmux pipe-pane` to write each pane's bytes into
// `<stateDir>/logs/tmux/<paneId>.log` (see `pipe-pane-capture.ts`). On Enter
// the right-pane controller wants to point `cat` at that log directly — no
// re-render, no copy, byte-fidelity preserved. When the log file is missing
// or empty, the controller falls back to a small placeholder string written
// to `<stateDir>/.replay/<step>.txt`.
//
// This module is the source resolver. It either:
//   - returns `{ kind: 'file', path }` so the controller can `cat <existing>`
//     without copying bytes, or
//   - returns `{ kind: 'inline', text }` with the placeholder string so the
//     controller writes it to disk and `cat`s that file.

import { stat } from 'node:fs/promises'
import type { Path } from '../../services/types.ts'

export interface ResolveCommandPaneSourceOptions {
  /** Step name — used in headers and the "no captured output" branch. */
  readonly stepName: string
  /**
   * Absolute path to the pane log. When undefined (silent command, or
   * non-debug run), the resolver falls back to the inline placeholder.
   */
  readonly paneLogPath: Path | undefined
}

export type CommandPaneSource =
  | { readonly kind: 'file'; readonly path: Path }
  | { readonly kind: 'inline'; readonly text: string }

const NO_CAPTURE_MESSAGE = (stepName: string): string =>
  `── ${stepName} ──\r\n(no captured output — silent command, or non-debug run)\r\n`

export async function resolveCommandPaneSource(
  opts: ResolveCommandPaneSourceOptions,
): Promise<CommandPaneSource> {
  if (opts.paneLogPath === undefined) {
    return { kind: 'inline', text: NO_CAPTURE_MESSAGE(opts.stepName) }
  }
  try {
    const info = await stat(opts.paneLogPath)
    if (info.size === 0) {
      return { kind: 'inline', text: NO_CAPTURE_MESSAGE(opts.stepName) }
    }
    return { kind: 'file', path: opts.paneLogPath }
  } catch {
    return { kind: 'inline', text: NO_CAPTURE_MESSAGE(opts.stepName) }
  }
}
