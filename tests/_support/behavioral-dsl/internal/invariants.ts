/**
 * Invariant contract — the single source of truth for "what
 * `exitedNormally()`, `tmuxIsTornDown()`, `terminalRestoredCleanly()`
 * (etc.) compose into for a given scenario." Plan §6.5 of the origin doc
 * is the spec; U6 wires the per-scenario contract table; U10 splits the
 * legacy `closeTerminal` row into `close-stdin` + `signal-sighup`.
 */

import {
  exitedNormally,
  noOrphanChildren,
  terminalRestoredCleanly,
  tmuxIsTornDown,
} from '../outcome-matchers.ts'
import type { LifecycleSnapshot, Matcher } from './snapshot.ts'

export type ScenarioTag =
  | 'signal-sigint'
  | 'signal-sigterm'
  | 'signal-sighup'
  | 'close-stdin'
  | 'attach-tty-ctrl-c'
  | 'pane-q-during-run'
  | 'pane-q-at-completion'
  | 'external-kill-pane'
  | 'external-kill-session'
  | 'external-kill-server'

export interface InvariantViolation {
  readonly matcher: string
  readonly detail: string
}

interface ScenarioSpec {
  readonly matchers: () => readonly Matcher[]
  /** Optional matcher that gates whether the scenario applies — e.g.
   *  `pane-q-during-run` only applies once orch has had a chance to react. */
}

// ─── Contract table — plan §6.5 ───────────────────────────────────────────
//
// The lazy matcher factories mean we don't construct matcher closures at
// module import time (CLAUDE.md rule #8 — no side effects at import).
const CONTRACT: Readonly<Record<ScenarioTag, ScenarioSpec>> = {
  // Signal handler at execute-with-attach.ts:64-74: SIGINT teardown then exit
  // EXIT.SIGINT (130). State store flushes 'crashed' before exit.
  'signal-sigint': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  'signal-sigterm': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  'signal-sighup': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  // close-stdin is a weaker invariant — orch may continue running (no handler
  // for stdin-EOF). The contract documents observed behavior; reviewers refine
  // as cells exercise it (U10 owns the row's evolution).
  'close-stdin': {
    matchers: () => [terminalRestoredCleanly()],
  },
  'attach-tty-ctrl-c': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  // Origin §2.1 — `q` during a running step. Post-fix contract: orch tears
  // down cleanly (exit code 130 / SIGINT) and the tmux session is gone.
  // `hasStatus('cancelled')` is intentionally OMITTED here — matches the
  // `signal-sigint` row, which also doesn't assert on persisted state. The
  // U7 docblock tracks "flush state.json on SIGINT/quit teardown" as a
  // follow-up; lifting both rows together is the right shape for that
  // change.
  'pane-q-during-run': {
    matchers: () => [exitedNormally(), tmuxIsTornDown()],
  },
  'pane-q-at-completion': {
    matchers: () => [exitedNormally(), tmuxIsTornDown(), terminalRestoredCleanly()],
  },
  'external-kill-pane': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  'external-kill-session': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
  'external-kill-server': {
    matchers: () => [
      exitedNormally(),
      tmuxIsTornDown(),
      terminalRestoredCleanly(),
      noOrphanChildren(),
    ],
  },
}

export const runInvariantContract = (
  snapshot: LifecycleSnapshot,
  scenario: ScenarioTag,
): readonly InvariantViolation[] => {
  const spec = CONTRACT[scenario]
  if (spec === undefined) {
    throw new Error(`runInvariantContract: unknown scenario tag ${JSON.stringify(scenario)}`)
  }
  const violations: InvariantViolation[] = []
  for (const matcher of spec.matchers()) {
    const result = matcher(snapshot)
    if (!result.matched) {
      // The matcher's message is shaped "<name>: actual=<X>" already; we
      // store the human-readable detail and extract a short matcher name for
      // structured diffs.
      const [name] = result.message.split(':', 1)
      violations.push({
        matcher: name?.trim() ?? '<unknown>',
        detail: result.message,
      })
    }
  }
  return violations
}
