// ---------------------------------------------------------------------------
// scratch-session — per-run sibling tmux session that hosts hidden source panes.
// ---------------------------------------------------------------------------
//
// Vocabulary (used across the pane-map module):
//   - **Visible pane** — the right pane the user sees in the `orch` session.
//     Always a swap target; never directly hosts a runner / tail / rollup
//     process. Its pane id changes after every successful `swap-pane`.
//   - **Hidden source pane** — a pane in this scratch session that hosts the
//     actual process for one source (autonomous tail, command-step tail,
//     parallel-block rollup tail, interactive runner PTY, kind-details
//     placeholder, frozen replay tail). One hidden pane per `SourceKey`
//     entry in the controller's `panes` map.
//   - **Swap target** — what the visible pane *is*, not what it does. Every
//     state change funnels through `tmux swap-pane src=<hidden>, dst=<visible>`.
//   - **Scratch session** — this one (`orch-scratch`). Deliberately
//     unattached: no `tmux attach` is ever issued against it, so the only
//     way a user observes a hidden pane is via swap. Avoid "attach" in
//     comments and identifiers.
//
// Bootstrap ordering (load-bearing — see `tmux-host.ts`):
//   1. `orch` session is created by `initOrchSession`.
//   2. `createScratchSession` runs BEFORE the visible right-pane splitPane.
//      If session creation fails, the visible right pane has not yet been
//      split, so no orphaned UI exists.
//   3. `splitPane` adds the visible right pane to `orch`.
//   4. `createRightPaneController` runs against both sessions.
//
// Teardown: `teardownScratchSession` runs BEFORE killing the `orch` session
// so the hidden source panes never outlive their swap target.
//
// User-config resilience: `destroy-unattached off` is set explicitly on the
// session at create time. A user's `~/.tmux.conf` with `destroy-unattached
// on` would otherwise tear the session down the moment we create it (no
// client attached) — that's the wrong outcome here, since no client will
// ever attach.
//
// Initial-pane holder: the scratch session is created with an explicit
// `sleep infinity` holder argv (see `SCRATCH_HOLDER_ARGV` below). Without
// it, tmux would spawn the user's `$SHELL` as the initial pane's process,
// which can exit on its own (login-shell `EXIT` traps, errexit, a sourced
// rc that returns nonzero, idle timeouts). If that single initial pane
// exits AND every other hidden pane has been killed at the same instant
// (e.g. between two interactive steps), the scratch session goes
// pane-less and tmux destroys it — combined with `exit-empty on` (the
// tmux default — orch overrides this server-wide in the appliance config,
// but the holder is belt-and-suspenders), the whole tmux server would
// die. See incident r-2026-05-22-093650-j0.

import type { SocketName, TmuxService } from '../../../services/tmux/index.ts'

/** Session name (relative to the per-run socket `orch-<runId>`). */
export const SCRATCH_SESSION_NAME = 'orch-scratch'

/**
 * Holder shell-command for the scratch session's initial pane. Passed as a
 * single trailing argument to `tmux new-session`, which then runs it under
 * `/bin/sh -c`. `cat` with its default stdin (the tmux pane's pty, which
 * is never written to in the scratch session) blocks indefinitely without
 * burning CPU and without depending on any non-POSIX flags. Earlier
 * iterations tried `sleep infinity`, but BSD `sleep` on macOS rejects it
 * with a usage error — the holder exited immediately and (combined with
 * the tmux default `exit-empty on`) brought the whole server down.
 *
 * Single-element argv: tmux's `cmd_to_string` joins multi-arg argv into
 * one space-separated string before passing to `/bin/sh -c`, so multi-arg
 * `['sh', '-c', ...]` shapes hit quoting traps. One arg ⇒ one shell
 * command, no surprises.
 */
export const SCRATCH_HOLDER_ARGV: readonly string[] = ['cat']

export interface CreateScratchSessionDeps {
  readonly tmux: TmuxService
  readonly socket: SocketName
  /** Width/height mirror the visible `orch` session at create time. */
  readonly width: number
  readonly height: number
}

export interface ScratchSessionHandle {
  readonly socket: SocketName
  readonly session: string
}

/**
 * Create the per-run scratch session. Returns a handle the caller threads
 * into `teardownScratchSession` at host teardown.
 */
export const createScratchSession = async (
  deps: CreateScratchSessionDeps,
): Promise<ScratchSessionHandle> => {
  await deps.tmux.createSession({
    socket: deps.socket,
    session: SCRATCH_SESSION_NAME,
    width: deps.width,
    height: deps.height,
    command: SCRATCH_HOLDER_ARGV,
  })
  // Pin `destroy-unattached off` so the user's `~/.tmux.conf` cannot tear
  // the session down behind our back. No client ever attaches to this
  // session — by design — so the tmux default `destroy-unattached on` (when
  // the user sets it) would race us. Set globally because per-session
  // option scoping for this option is tmux-version-sensitive; `-g` is the
  // robust path. The orch run owns the per-run tmux server, so a global
  // option is scoped to this run.
  await deps.tmux.setOption({
    socket: deps.socket,
    target: SCRATCH_SESSION_NAME,
    name: 'destroy-unattached',
    value: 'off',
    global: true,
  })
  return { socket: deps.socket, session: SCRATCH_SESSION_NAME }
}

/**
 * Tear down the scratch session. MUST run before the visible `orch` session
 * is killed so the hidden panes can't outlive their swap target.
 *
 * Idempotent — tolerates "session not found" so teardown is safe to run
 * twice or after a racing teardown already killed the session.
 */
export const teardownScratchSession = async (
  tmux: TmuxService,
  handle: ScratchSessionHandle,
): Promise<void> => {
  await tmux.killSession({ socket: handle.socket, session: handle.session })
}
