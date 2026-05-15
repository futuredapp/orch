// Per-test socket allocation for the real-tmux harness.
//
// Each fixture gets a dedicated tmux socket so parallel test runs do not
// collide. Names follow the SocketName grammar (`/^[a-z0-9-]+$/`) and embed
// the pid plus a crypto-random nonce so the same process can spin up many
// concurrent fixtures without reusing a socket name.

import { randomBytes } from 'node:crypto'
import { type SocketName, socketName } from '../../../src/services/tmux/index.ts'

/**
 * Allocate a unique SocketName for a harness fixture. Tag is an optional
 * short label for debugging — restricted to `[a-z0-9-]+` so it can flow into
 * the socket name verbatim. Defaults to `t`.
 */
export function allocateSocketName(tag = 't'): SocketName {
  if (!/^[a-z0-9-]+$/.test(tag)) {
    throw new Error(
      `allocateSocketName(): tag must match /^[a-z0-9-]+$/, got ${JSON.stringify(tag)}`,
    )
  }
  const nonce = randomBytes(4).toString('hex')
  return socketName(`orch-${tag}-${process.pid}-${nonce}`)
}

/**
 * Throws a clear, actionable error when the fixture is created from inside
 * an existing tmux session. tmux exposes `$TMUX` only when the current shell
 * runs under tmux, so this is a reliable indicator. The harness cannot boot
 * its own server safely from inside one — `attach-session` silently routes
 * to the outer server and the test would observe the user's real panes.
 */
export function assertNoNestedTmux(env: Readonly<Record<string, string | undefined>>): void {
  const tmuxEnv = env.TMUX
  if (typeof tmuxEnv === 'string' && tmuxEnv.length > 0) {
    throw new Error(
      'real-tmux harness: refusing to run inside a tmux session — $TMUX is set. ' +
        'Run the tests from a shell outside tmux.',
    )
  }
}
