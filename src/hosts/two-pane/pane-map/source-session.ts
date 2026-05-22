// ---------------------------------------------------------------------------
// source-session — one tmux session per source (replaces scratch-session).
// ---------------------------------------------------------------------------
//
// Vocabulary (used across the pane-map module):
//   - **Visible pane** — the right pane the user sees in the `orch` session.
//     Always a swap target; never directly hosts a runner / tail / rollup
//     process. Its pane id changes after every successful `swap-pane`.
//   - **Hidden source pane** — a pane in a per-source tmux session that hosts
//     the actual process for one source (autonomous tail, command-step tail,
//     parallel-block rollup tail, interactive runner PTY, kind-details
//     placeholder, frozen replay tail). One hidden pane per `SourceKey` entry
//     in the controller's `panes` map; one tmux session per hidden pane.
//   - **Swap target** — what the visible pane *is*, not what it does. Every
//     state change funnels through `tmux swap-pane src=<hidden>, dst=<visible>`.
//     `swap-pane` is cross-session because tmux pane ids are server-wide.
//   - **Per-source session** — `orch-src-<sanitized-key>`. Deliberately
//     unattached: no `tmux attach` is ever issued against it, so the only
//     way a user observes a hidden pane is via swap. Avoid "attach" in
//     comments and identifiers.
//
// Why per-source (not the historical single `orch-scratch` session):
//   the shared scratch session piled hidden panes into one window via
//   repeated `split-window` calls. After ~5 panes the active pane fell
//   below tmux's minimum splittable width and the next `split-window`
//   failed with `no space for new pane` — see run r-2026-05-22-135756-tc
//   and `docs/plans/2026-05-22-001-refactor-per-source-tmux-sessions-plan.md`.
//   One session per source removes `split-window` from the spawn path
//   entirely; the failure mode is gone by construction.
//
// Bootstrap ordering (load-bearing — see `tmux-host.ts`):
//   1. `orch` session is created by `initOrchSession`.
//   2. `set -g destroy-unattached off` is pinned globally during orch-session
//      init (see `src/services/tmux/session-init.ts`). This MUST be in place
//      before any `createSourceSession` call — per-source sessions never have
//      a client attached, and a user's `~/.tmux.conf` with
//      `destroy-unattached on` would otherwise tear them down on creation.
//   3. `splitPane` adds the visible right pane to `orch`.
//   4. `createRightPaneController` runs against the visible orch session.
//   5. Per-source sessions are created lazily on `registerSource(...)`.
//
// Teardown: each per-source session is torn down via `teardownSourceSession`
// BEFORE the visible `orch` session is killed, so hidden source panes never
// outlive their swap target. The controller's `teardownSessions()` drains
// the `panes` map.
//
// Holder vs. source-as-pane:
//   The historical `orch-scratch` session used a `cat` holder as its initial
//   pane because the session itself had no "source." With per-source
//   sessions, the initial pane IS the source process for every type EXCEPT
//   `placeholder` — that source has no underlying process and still needs
//   the holder to keep its session alive across swap-out periods.
//
//   The historical holder rationale (carried forward from the deleted
//   `scratch-session.ts`): without an explicit holder, tmux spawns the
//   user's `$SHELL` as the initial pane's process, which can exit on its
//   own (login-shell `EXIT` traps, errexit, a sourced rc that returns
//   nonzero, idle timeouts). If that initial pane exits AND every other
//   hidden pane has been killed at the same instant, the session goes
//   pane-less and tmux destroys it — combined with `exit-empty on` (the
//   tmux default — orch overrides this server-wide in the appliance config,
//   but the holder is belt-and-suspenders), the whole tmux server would
//   die. See incident r-2026-05-22-093650-j0.
//
// Holder argv shape:
//   Single-element argv: tmux's `cmd_to_string` joins multi-arg argv into
//   one space-separated string before passing to `/bin/sh -c`, so multi-arg
//   `['sh', '-c', ...]` shapes hit quoting traps. One arg ⇒ one shell
//   command, no surprises. Earlier iterations tried `sleep infinity`, but
//   BSD `sleep` on macOS rejects it with a usage error — the holder exited
//   immediately and (combined with the tmux default `exit-empty on`)
//   brought the whole server down. `cat` with its default stdin (the tmux
//   pane's pty, which is never written to in an un-attached session)
//   blocks indefinitely without burning CPU and without depending on any
//   non-POSIX flags.

import { createHash } from 'node:crypto'
import type { PaneId, SocketName, TmuxService } from '../../../services/tmux/index.ts'
import type { Path } from '../../../services/types.ts'

/** Session-name prefix for every per-source tmux session. */
export const SOURCE_SESSION_PREFIX = 'orch-src-'

/**
 * Holder argv for sessions whose initial pane has no real source process
 * (currently only `placeholder`). See module header for rationale.
 */
export const SOURCE_HOLDER_ARGV: readonly string[] = ['cat']

/**
 * Maximum length of a tmux session name produced by `sanitizeSessionName`.
 * tmux itself is more permissive, but long names confuse `tmux ls` output
 * and shrink the human-readable window in lifecycle logs. Inputs that would
 * exceed this length are truncated and disambiguated with an 8-char hex
 * hash of the un-truncated form.
 */
export const MAX_SESSION_NAME_LENGTH = 64

const HASH_SUFFIX_LENGTH = 8 // hex chars
// `[^a-z0-9-]` matches anything that's not lowercase alphanumeric or `-`.
// tmux session names forbid `.`, `:`, and whitespace; the source-key
// language uses `:` as a separator and may carry `.` from step names that
// were `.`-namespaced. Anything else (`=`, `\t`, `\n`, spaces) is also
// mapped to `-` for the same reason.
const ILLEGAL_CHARS = /[^a-z0-9-]/g

/**
 * Map a `SourceKey` string (the output of `sourceKeyToString`) to a tmux
 * session name. Pure function — deterministic for a given input, no side
 * effects, no I/O.
 *
 *   `live:command:assign-roles-1` → `orch-src-live-command-assign-roles-1`
 *   `replay:step.with.dots`       → `orch-src-replay-step-with-dots`
 *   `interactive:has space and\ttab` → `orch-src-interactive-has-space-and-tab`
 *   `placeholder`                 → `orch-src-placeholder`
 *
 * Truncation: when the un-prefixed sanitized form exceeds
 * `MAX_SESSION_NAME_LENGTH - SOURCE_SESSION_PREFIX.length` chars, the result
 * is truncated and an 8-char hex hash of the *un-truncated* input is
 * appended so two long inputs sharing their first chars don't collide.
 */
export const sanitizeSessionName = (key: string): string => {
  const lowered = key.toLowerCase()
  const replaced = lowered.replace(ILLEGAL_CHARS, '-')
  const budget = MAX_SESSION_NAME_LENGTH - SOURCE_SESSION_PREFIX.length
  if (replaced.length <= budget) {
    return `${SOURCE_SESSION_PREFIX}${replaced}`
  }
  const hash = createHash('sha1').update(key).digest('hex').slice(0, HASH_SUFFIX_LENGTH)
  const keepLen = budget - HASH_SUFFIX_LENGTH - 1 // 1 for the `-` separator
  const truncated = replaced.slice(0, keepLen)
  return `${SOURCE_SESSION_PREFIX}${truncated}-${hash}`
}

export interface SourceSessionHandle {
  readonly socket: SocketName
  readonly session: string
  readonly paneId: PaneId
}

export interface CreateSourceSessionOptions {
  readonly tmux: TmuxService
  readonly socket: SocketName
  /** Pre-sanitized session name (produced by `sanitizeSessionName`). */
  readonly sessionName: string
  /** Width/height mirror the visible `orch` session at create time. */
  readonly width: number
  readonly height: number
  /**
   * Argv for the initial pane's process. For every source EXCEPT
   * `placeholder` this is the source's real process (the `tail -F …` for
   * file-tail, the runner PTY argv for pty). For `placeholder`, pass
   * `SOURCE_HOLDER_ARGV` (a dormant `cat`) — the placeholder source has no
   * underlying byte stream but its session must stay alive across swap-out
   * periods.
   */
  readonly command: readonly string[]
  /**
   * Optional per-session env overrides for the initial pane's process. Used
   * by interactive `pty` sources to carry runner-specific env (e.g.
   * `FORCE_COLOR=3`). Mirrors `splitPane`'s argv-variant env field.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Optional initial pane cwd. Used by interactive `pty` sources so the
   * runner process starts inside the project directory.
   */
  readonly cwd?: Path
}

/**
 * Create one per-source tmux session whose initial pane runs `command`.
 * Returns the new session's name + the initial pane id (parsed by the
 * underlying `tmux new-session -P -F '#{pane_id}'`).
 *
 * No `split-window` ever runs against the returned session — that's the
 * load-bearing property this module exists to enforce. The controller stores
 * the returned `paneId` directly in the `panes` map and uses it for every
 * subsequent `swap-pane` against the visible slot.
 */
export const createSourceSession = async (
  opts: CreateSourceSessionOptions,
): Promise<SourceSessionHandle> => {
  const result = await opts.tmux.createSession({
    socket: opts.socket,
    session: opts.sessionName,
    width: opts.width,
    height: opts.height,
    command: opts.command,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  return {
    socket: opts.socket,
    session: opts.sessionName,
    paneId: result.paneId,
  }
}

/**
 * Tear down one per-source session. Idempotent — the underlying
 * `TmuxService.killSession` adapter already tolerates "session not found"
 * and "no server running" as no-ops, so a racing teardown or an already-
 * gone session does not throw. Any other tmux failure (malformed argv,
 * permissions) surfaces unchanged.
 *
 * Hidden source panes MUST be torn down BEFORE the visible `orch` session
 * is killed; the controller's `teardownSessions()` enforces that ordering.
 */
export const teardownSourceSession = async (
  tmux: TmuxService,
  handle: Pick<SourceSessionHandle, 'socket' | 'session'>,
): Promise<void> => {
  await tmux.killSession({ socket: handle.socket, session: handle.session })
}
