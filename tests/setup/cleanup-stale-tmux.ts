// Pre-suite cleanup of leaked tmux state.
//
// Each Tier 1 / Tier 5 fixture boots its own `tmux -L orch-…` server and
// kills it on dispose(). Interrupted runs (Ctrl-C, OOM, crashes) leak the
// server and its socket file. Accumulated leftovers eventually breach
// per-uid process and fd limits, after which new fixtures fail at boot and
// every test in the suite reports a fast (<5 ms) failure that looks nothing
// like a real assertion.
//
// Wired via `bunfig.toml`'s `[test] preload`, this module runs once before
// the suite starts and reaps any leftover `orch-*` sockets together with
// their servers.
//
// Safety rails:
//   - Only sockets whose name starts with `orch-` are touched.
//   - Sockets newer than STALE_AGE_MS are left alone, so a parallel
//     `bun test` on the same host keeps its in-flight fixtures.

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const SOCKET_NAME_PREFIX = 'orch-'
const STALE_AGE_MS = 5 * 60 * 1000

async function cleanupStaleSockets(): Promise<void> {
  const cutoff = Date.now() - STALE_AGE_MS
  for (const dir of candidateSocketDirs()) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.startsWith(SOCKET_NAME_PREFIX)) continue
      const full = join(dir, name)
      try {
        const info = await stat(full)
        if (info.mtimeMs > cutoff) continue
      } catch {
        continue
      }
      // `tmux -L <name> kill-server` is idempotent. Non-zero exit just means
      // the server was already gone; we still try to remove the socket file
      // below to handle the case where tmux died but left its socket behind.
      const proc = Bun.spawn(['tmux', '-L', name, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await proc.exited
      await rm(full, { force: true }).catch(() => {})
    }
  }
}

function candidateSocketDirs(): readonly string[] {
  const uid = process.getuid?.() ?? 0
  const dirs = new Set<string>()
  const tmuxTmpdir = process.env.TMUX_TMPDIR
  if (typeof tmuxTmpdir === 'string' && tmuxTmpdir.length > 0) {
    dirs.add(join(tmuxTmpdir, `tmux-${uid}`))
  }
  // macOS resolves `/tmp` through `/private/tmp`. Both forms appear in the
  // wild depending on whether tmux was started with a resolved cwd; check
  // each so the sweep is exhaustive on darwin too.
  dirs.add(`/tmp/tmux-${uid}`)
  dirs.add(`/private/tmp/tmux-${uid}`)
  return [...dirs]
}

await cleanupStaleSockets()
