// ---------------------------------------------------------------------------
// pipe-pane capture — debug-only tmux pane byte logging.
// ---------------------------------------------------------------------------
//
// `tmux pipe-pane` tees a pane's stdout into a shell command. We use
// `cat >> <path>` so tmux appends every pane byte to a file we control. The
// path is absolute (tmux runs the command via `/bin/sh -c`, which has no
// working-dir guarantees) and single-quoted so weird chars in the logs dir
// path can't inject.
//
// Called from TmuxHost when `logger.debug === true`. Starts a pipe for each
// pane post-creation; tear-down passes empty `command` to drop the pipe.

import type { FsService, Path } from '../../services/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import { path } from '../../services/types.ts'

interface StartPipePaneCaptureDeps {
  readonly tmux: TmuxService
  readonly fs: FsService
  readonly socket: SocketName
  readonly logsDir: Path
  readonly panes: readonly PaneId[]
  readonly onError: (err: unknown) => void
}

export interface PipePaneCapture {
  stop(): Promise<void>
}

export async function startPipePaneCapture(
  deps: StartPipePaneCaptureDeps,
): Promise<PipePaneCapture> {
  const tmuxDir = path(`${deps.logsDir}/tmux`)
  try {
    await deps.fs.mkdir(tmuxDir, { recursive: true })
  } catch (err) {
    deps.onError(err)
    return { async stop() {} }
  }

  const started: PaneId[] = []
  for (const pane of deps.panes) {
    const filePath = path(`${tmuxDir}/${sanitizePaneIdForFile(pane)}.log`)
    try {
      await deps.tmux.pipePane({
        socket: deps.socket,
        target: pane,
        command: `cat >> ${shellQuote(filePath)}`,
      })
      started.push(pane)
    } catch (err) {
      deps.onError(err)
    }
  }

  return {
    async stop() {
      for (const pane of started) {
        try {
          // Empty command drops an existing pipe (tmux's native semantics).
          await deps.tmux.pipePane({ socket: deps.socket, target: pane, command: '' })
        } catch (err) {
          deps.onError(err)
        }
      }
    },
  }
}

// Pane ids look like `%12`. `%` is path-safe but some tooling chokes; we keep
// the literal id so the filename maps 1:1 to tmux's identity.
function sanitizePaneIdForFile(id: PaneId): string {
  return id
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
