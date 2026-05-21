// ---------------------------------------------------------------------------
// attach-foreground — tmux auto-attach mechanics extracted from tmux-host.ts.
// ---------------------------------------------------------------------------
//
// Two small responsibilities, split out so tmux-host.ts stays under the
// 300-line soft limit (CLAUDE.md rule #5):
//
//   1. `assertNoNestedTmux(env)` — throws HostCreationError with the
//      three-option escape message when `$TMUX` is set.
//   2. `createAttachForeground(deps)` — returns the `attachForeground()`
//      closure the TmuxHost exposes on the Host port. Uses `teardownStarted`
//      state supplied by the host to distinguish "we killed the session"
//      from "the attach client died for some other reason".
//
// `path()` is applied at call-site: process.cwd() has already been screened
// by the CLI (it's our own process), but the service boundary expects the
// branded type. See src/services/types.ts.

import { path } from '../../core/types.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type { SocketName } from '../../services/tmux/index.ts'
import { HostCreationError } from '../host.ts'

const SESSION = 'orch'

const NESTED_TMUX_MESSAGE =
  '[orch] cannot auto-attach — already inside a tmux session. Options:\n' +
  '         (1) run `tmux -L orch-<runId> attach -t orch` from a pane, OR\n' +
  '         (2) run orch outside tmux, OR\n' +
  '         (3) use --mode=plain'

/**
 * Throws `HostCreationError` with the nested-tmux guidance when `$TMUX` is
 * non-empty. Called from `createTmuxHost` before any session work so the
 * CLI never creates a server it then can't attach a client to.
 *
 * Pass `skipAttach: true` (the `--no-attach` path) to bypass the guard —
 * there's no attach client to misroute when we never spawn one.
 */
export function assertNoNestedTmux(
  env: Readonly<Record<string, string | undefined>>,
  skipAttach: boolean,
): void {
  if (skipAttach) return
  if (typeof env.TMUX === 'string' && env.TMUX.length > 0) {
    throw new HostCreationError(NESTED_TMUX_MESSAGE)
  }
}

export interface AttachForegroundDeps {
  readonly processService: ProcessService
  readonly socket: SocketName
  readonly stderr: NodeJS.WritableStream
  readonly cwd: string
  /** When true, the returned closure is a resolved-immediately no-op. */
  readonly skipAttach: boolean
  /**
   * Read lazily — the host flips this to `true` inside `teardown()` before
   * `kill-session` fires, so `attachForeground` can tell a clean race-exit
   * (workflow finished → teardown → session killed) from an unexpected
   * crash.
   */
  readonly isTeardownStarted: () => boolean
}

export interface AttachForegroundResult {
  readonly skipped: boolean
  readonly exitCode: number | null
  readonly teardownStarted: boolean
}

/**
 * Builds the `attachForeground()` closure for `TmuxHost`. Spawns
 * `tmux -L <socket> attach-session -t <session>` with inherited stdio and
 * resolves when the client exits. Never throws — a failed attach just logs
 * a diagnostic to stderr so the CLI's race-or-wait flow stays intact.
 */
export function createAttachForeground(
  deps: AttachForegroundDeps,
): () => Promise<AttachForegroundResult> {
  return async () => {
    if (deps.skipAttach) {
      return { skipped: true, exitCode: null, teardownStarted: deps.isTeardownStarted() }
    }
    const handle = deps.processService.spawnForeground({
      argv: ['tmux', '-L', deps.socket, 'attach-session', '-t', SESSION],
      env: filterEnv(process.env),
      cwd: path(deps.cwd),
    })
    const { exitCode } = await handle.wait()
    const teardownStarted = deps.isTeardownStarted()
    if (exitCode !== 0 && !teardownStarted) {
      deps.stderr.write(`[orch tmux] attach exited with code ${exitCode}\n`)
    }
    return { skipped: false, exitCode, teardownStarted }
  }
}

/**
 * `ProcessService.spawnForeground` requires `Record<string, string>`; strip
 * the `undefined` values `process.env` can legally hold (typed as
 * `string | undefined`) so the attach child inherits everything else.
 */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}
