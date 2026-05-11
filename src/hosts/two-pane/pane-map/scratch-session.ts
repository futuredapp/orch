// ---------------------------------------------------------------------------
// scratch-session — per-run sibling tmux session that hosts hidden panes.
// ---------------------------------------------------------------------------
//
// Every "source" the right pane can show lives as a hidden pane in this
// session. The visible `orch` session's right pane is swapped with one of
// these hidden panes on demand. The session has no clients (no `tmux
// attach`); it exists purely to give swap-pane somewhere to spawn process
// state.
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
// so the hidden panes never outlive their swap target.
//
// User-config resilience: `destroy-unattached off` is set explicitly on the
// session at create time. A user's `~/.tmux.conf` with `destroy-unattached
// on` would otherwise tear the session down the moment we create it (no
// client attached) — that's the wrong outcome here, since no client will
// ever attach.

import type { SocketName, TmuxService } from '../../../services/tmux/index.ts'

/** Session name (relative to the per-run socket `orch-<runId>`). */
export const SCRATCH_SESSION_NAME = 'orch-scratch'

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
