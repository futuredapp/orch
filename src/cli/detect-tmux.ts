// Tmux detection helpers for the CLI entrypoint. These are pure enough to
// test against a `ProcessService` (version probe) and against `process.env`
// (running-inside-tmux probe). No tmux subprocess management lives here —
// that's TmuxService's job.

import type { ProcessService } from '../services/process/index.ts'
import { path } from '../services/types.ts'

/** Minimum tmux version required for the observability features in 13b/13c. */
export const MIN_TMUX_MAJOR = 3
export const MIN_TMUX_MINOR = 2

/**
 * Returns `true` if the orchestrator is running inside an existing tmux
 * client. Only inspects env vars — never talks to any tmux server.
 *
 * `$TMUX` is set for every pane; `$TMUX_PANE` is set alongside it. We look
 * at `$TMUX` because the full path form (`/tmp/tmux-.../default,<pid>,0`)
 * only appears when a real server owns the pane.
 */
export const isInsideTmux = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => typeof env.TMUX === 'string' && env.TMUX.length > 0

export interface TmuxVersionInfo {
  readonly raw: string
  readonly major: number
  readonly minor: number
}

const VERSION_PATTERN = /tmux\s+(\d+)\.(\d+)([a-z]?)/i

/**
 * Runs `tmux -V` and parses the version string. Returns `undefined` if
 * tmux is missing from `PATH`; throws if tmux is present but output is
 * unparseable (suspicious — treat as caller error).
 */
export const probeTmuxVersion = async (
  processService: ProcessService,
): Promise<TmuxVersionInfo | undefined> => {
  if (Bun.which('tmux') === null) return undefined

  const handle = processService.spawn({
    argv: ['tmux', '-V'],
    cwd: path('/'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LANG: process.env.LANG ?? 'C',
    },
  })

  const parts: string[] = []
  for await (const line of handle.stdout) parts.push(line)
  const { exitCode } = await handle.wait()
  if (exitCode !== 0) return undefined

  const raw = parts.join('\n').trim()
  const match = raw.match(VERSION_PATTERN)
  if (match === null) {
    throw new Error(`probeTmuxVersion: unparseable tmux -V output ${JSON.stringify(raw)}`)
  }
  const [, majorStr, minorStr] = match
  return {
    raw,
    major: Number.parseInt(majorStr as string, 10),
    minor: Number.parseInt(minorStr as string, 10),
  }
}

export const meetsMinimumTmuxVersion = (info: TmuxVersionInfo): boolean => {
  if (info.major > MIN_TMUX_MAJOR) return true
  if (info.major < MIN_TMUX_MAJOR) return false
  return info.minor >= MIN_TMUX_MINOR
}
