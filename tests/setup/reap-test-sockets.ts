// Liveness-gated reaper for leaked test tmux sockets.
//
// Every test-created tmux server lives in the reserved `orch-test-<pid>-<nonce>`
// namespace (see `tests/helpers/real-tmux/socket.ts`). A normal `dispose()` /
// `teardown()` kills its server, but an interrupted run (Ctrl-C, OOM, SIGKILL)
// leaks the server and its socket file. Left unchecked, the leftovers breach
// per-uid process/fd limits and the whole suite starts failing fast at boot.
//
// This module reaps those leaks with a predicate that is structurally incapable
// of touching a production server and deterministic against parallel runs:
//
//   reap(name) iff
//     name starts with `orch-test-`            # prefix gate — never orch-r-…
//     AND the embedded <pid> owner is dead     # process.kill(pid, 0) → ESRCH
//
// The prefix gate is what keeps a `bun test` sweep from killing a live
// production `orch-r-<runId>` workflow server that happens to share the host
// (the incident this fix addresses). The liveness gate is what keeps two
// parallel `bun test` invocations from reaping each other's *live* sockets —
// no age window, so a long-running fixture is never wrongly collected.
//
// There is intentionally NO top-level call here: the function is importable and
// dependency-injectable so its behavior can be tested without triggering a real
// sweep on import. The thin preload `cleanup-stale-tmux.ts` is the only place
// that invokes it (a deliberate, documented exception to the project's
// no-import-side-effects rule).

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pidFromTestSocket, RESERVED_TEST_PREFIX } from '../helpers/real-tmux/socket.ts'

export interface ReapStaleTestSocketsOptions {
  /** Candidate socket directories. Defaults to `candidateSocketDirs()`. */
  readonly dirs?: readonly string[]
  /** Liveness probe for an owner pid. Defaults to `isOwnerPidAlive`. */
  readonly isPidAlive?: (pid: number) => boolean
  /** Kill the tmux server named `name`. Defaults to `tmux -L <name> kill-server`. */
  readonly killServer?: (name: string) => Promise<void>
  /** Remove a leftover socket file at `path`. Defaults to `rm(path, { force })`. */
  readonly removeFile?: (path: string) => Promise<void>
}

/**
 * Reap leaked reserved-namespace test sockets whose owner process is dead.
 * Pure of import-time side effects; all I/O seams are injectable for testing.
 */
export async function reapStaleTestSockets(opts: ReapStaleTestSocketsOptions = {}): Promise<void> {
  const dirs = opts.dirs ?? candidateSocketDirs()
  const isPidAlive = opts.isPidAlive ?? isOwnerPidAlive
  const killServer = opts.killServer ?? defaultKillServer
  const removeFile = opts.removeFile ?? defaultRemoveFile

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // Missing/unreadable candidate dir — nothing to reap here.
      continue
    }
    for (const name of entries) {
      if (!name.startsWith(RESERVED_TEST_PREFIX)) continue
      const pid = pidFromTestSocket(name)
      if (pid === undefined) continue
      if (isPidAlive(pid)) continue

      // Confirmed-dead owner. Kill the server (idempotent — a non-zero exit just
      // means it was already gone) then remove the socket file, which also
      // handles the "tmux died but left its socket behind" case.
      await killServer(name)
      await removeFile(join(dir, name))
    }
  }
}

/**
 * Default owner-liveness probe. `process.kill(pid, 0)` signals nothing but still
 * performs the permission/existence check: it throws `ESRCH` when no such
 * process exists (dead → not alive) and `EPERM` when the process exists but is
 * owned by another user (alive, but not ours). Per KTD-4 the pid-reuse edge errs
 * **safe**: any non-`ESRCH` error is treated as alive, so the sweep skips an
 * orphan rather than risk a wrongful kill.
 */
export function isOwnerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

async function defaultKillServer(name: string): Promise<void> {
  const proc = Bun.spawn(['tmux', '-L', name, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

async function defaultRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {})
}

/**
 * Candidate on-disk directories for tmux sockets. tmux resolves its socket dir
 * from `$TMUX_TMPDIR/tmux-<uid>` falling back to `/tmp/tmux-<uid>`; macOS
 * surfaces the latter as `/private/tmp/...`. Shared shape with
 * `tests/helpers/real-tmux/fixture.ts`'s `socketFilePaths`.
 */
export function candidateSocketDirs(): readonly string[] {
  const uid = process.getuid?.() ?? 0
  const dirs = new Set<string>()
  const tmuxTmpdir = process.env.TMUX_TMPDIR
  if (typeof tmuxTmpdir === 'string' && tmuxTmpdir.length > 0) {
    dirs.add(join(tmuxTmpdir, `tmux-${uid}`))
  }
  dirs.add(`/tmp/tmux-${uid}`)
  dirs.add(`/private/tmp/tmux-${uid}`)
  return [...dirs]
}
