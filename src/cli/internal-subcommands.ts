// ---------------------------------------------------------------------------
// internal-subcommands — hidden re-entry points for the compiled binary.
// ---------------------------------------------------------------------------
//
// A `bun build --compile` binary (the Homebrew install) has a single
// entrypoint, so an embedded TUI child cannot be spawned as `[orch,
// /$bunfs/root/steps-view-runner.tsx, ...]` — the binary treats that path as a
// CLI command, prints "Unknown command", and exits 2, killing the pane. The
// launchers instead re-invoke `[orch, <subcommand>, ...]`; this table routes
// the subcommand straight to the runner.
//
// These commands are intentionally absent from HELP and are dispatched before
// flag parsing / mode resolution / the `[orch] mode=...` banner — none of which
// apply to a child pane. The SAME constant (`STEPS_VIEW_SUBCOMMAND`) is used by
// the launcher (`start-steps-view.ts`) and this dispatcher, so the producing
// and consuming halves of the contract cannot drift.

import {
  parseRunnerArgs,
  runStepsViewRunner,
  STEPS_VIEW_SUBCOMMAND,
} from '../hosts/two-pane/steps-view/index.ts'
import { ASK_SUBCOMMAND, parseAskRunnerArgs, runAskRunner } from '../services/prompt/index.ts'

export type InternalSubcommand = (rest: readonly string[]) => Promise<void>

const TABLE: Readonly<Record<string, InternalSubcommand>> = {
  [STEPS_VIEW_SUBCOMMAND]: async (rest) => {
    await runStepsViewRunner(parseRunnerArgs(rest))
  },
  [ASK_SUBCOMMAND]: async (rest) => {
    await runAskRunner(parseAskRunnerArgs(rest))
  },
}

/**
 * Resolve an internal re-entry subcommand to its handler, or `undefined` when
 * `command` is a normal user command (or absent). Keeping this a pure lookup
 * lets the dispatch contract be unit-tested without driving the live runner.
 */
export function findInternalSubcommand(
  command: string | undefined,
): InternalSubcommand | undefined {
  if (command === undefined) return undefined
  return TABLE[command]
}
