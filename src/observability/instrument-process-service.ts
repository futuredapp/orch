// ---------------------------------------------------------------------------
// instrumentProcessService — wrap a ProcessService so every non-agent spawn
// lands in `subprocesses.ndjson`. Debug-only; the CLI calls this after
// parsing `--debug` so the unwrapped service stays on the hot path under
// baseline runs.
// ---------------------------------------------------------------------------
//
// Design notes:
// - The wrapper proxies both `spawn()` and `spawnForeground()`. Agent spawns
//   set `tag: 'agent'` (see `SpawnOptions.tag`) and are skipped because they
//   already land in `spawns.ndjson` through the workflow executor.
// - We don't buffer stdout/stderr. The point is "what subprocesses did orch
//   issue?", not "what did they say" — heavy output lives in per-runner
//   rawSinks and `tmux/<paneId>.log`.
// - Errors from the logger are swallowed. A broken log must never fail a
//   live subprocess; the logger itself is best-effort.

import type { Clock, ProcessService } from '../services/index.ts'
import type { ForegroundHandle, SpawnHandle, SpawnOptions } from '../services/process/index.ts'
import { envKeys } from './redact.ts'
import type { SessionLogger } from './session-logger.ts'

export interface InstrumentProcessServiceDeps {
  readonly logger: SessionLogger
  readonly clock: Clock
}

/**
 * Wrap `base` so every non-agent spawn records to `subprocesses.ndjson`.
 * Returns `base` unchanged when `logger.debug` is false — zero overhead on
 * baseline runs.
 */
export function instrumentProcessService(
  base: ProcessService,
  deps: InstrumentProcessServiceDeps,
): ProcessService {
  if (!deps.logger.debug) return base

  const record = (
    kind: 'spawn' | 'spawnForeground',
    opts: SpawnOptions,
    outcome: { readonly exitCode: number; readonly durationMs: number },
  ): void => {
    if (opts.tag === 'agent') return
    void deps.logger
      .append('subprocesses', {
        kind,
        argv: opts.argv,
        envKeys: envKeys(opts.env),
        cwd: opts.cwd,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
      })
      .catch(() => {})
  }

  return {
    spawn(opts: SpawnOptions): SpawnHandle {
      const startedAt = deps.clock.now()
      const handle = base.spawn(opts)
      return {
        stdout: handle.stdout,
        stderr: handle.stderr,
        async wait() {
          const result = await handle.wait()
          record('spawn', opts, {
            exitCode: result.exitCode,
            durationMs: deps.clock.now() - startedAt,
          })
          return result
        },
        kill(signal) {
          handle.kill(signal)
        },
      }
    },
    spawnForeground(opts: SpawnOptions): ForegroundHandle {
      const startedAt = deps.clock.now()
      const handle = base.spawnForeground(opts)
      return {
        async wait() {
          const result = await handle.wait()
          record('spawnForeground', opts, {
            exitCode: result.exitCode,
            durationMs: deps.clock.now() - startedAt,
          })
          return result
        },
        kill(signal) {
          handle.kill(signal)
        },
      }
    },
  }
}
