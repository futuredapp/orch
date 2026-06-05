// Per-test socket allocation for the real-tmux harness.
//
// Every test-created tmux socket lives in the reserved `orch-test-` namespace:
// `orch-test-<pid>-<nonce>`. Two invariants ride on this grammar:
//
//   1. **Prod immunity.** Production sockets are `orch-r-<runId>` (the runId
//      always begins with `r-`, see `RUN_ID_PATTERN`), so the `orch-test-`
//      prefix can never collide with a live production server. The stale-socket
//      preload reaps strictly inside this namespace and therefore cannot kill a
//      workflow server (incident repro — see the fix plan).
//   2. **Liveness-gated reaping.** The first segment after `orch-test-` is the
//      decimal pid of the owning process. The preload parses it via
//      `pidFromTestSocket` and reaps only when that pid is dead, so a parallel
//      `bun test` never reaps another live run's socket.
//
// The `<nonce>` (crypto hex) lets one process spin up many concurrent fixtures
// without reusing a name. All segments satisfy the SocketName grammar
// (`/^[a-z0-9-]+$/`).

import { randomBytes } from 'node:crypto'
import { type SocketName, socketName } from '../../../src/services/tmux/index.ts'

/**
 * Reserved prefix for every test-created tmux socket. `orch-test-` structurally
 * cannot match a production `orch-r-<runId>` socket. The stale-socket preload
 * (`tests/setup/reap-test-sockets.ts`) and the audit guards import this constant
 * rather than re-literalizing the string.
 */
export const RESERVED_TEST_PREFIX = 'orch-test-'

/**
 * Allocate a unique reserved SocketName for a harness fixture, of the form
 * `orch-test-<pid>-<nonce>`. The embedded `<pid>` is the current process's pid
 * — the owner whose liveness the stale-socket preload checks before reaping.
 */
export function allocateSocketName(): SocketName {
  const nonce = randomBytes(4).toString('hex')
  return socketName(`${RESERVED_TEST_PREFIX}${process.pid}-${nonce}`)
}

/**
 * Parse the owner pid embedded in a reserved test socket name. Returns the pid
 * when `name` starts with `orch-test-` and the first following `-`-delimited
 * segment is all decimal digits; `undefined` otherwise (prod-shaped names, a
 * non-numeric first segment, or any name outside the reserved namespace).
 *
 * This is the single source of truth for the parse, shared by the reaper and
 * its tests.
 */
export function pidFromTestSocket(name: string): number | undefined {
  if (!name.startsWith(RESERVED_TEST_PREFIX)) return undefined
  const firstSegment = name.slice(RESERVED_TEST_PREFIX.length).split('-', 1)[0]
  if (firstSegment === undefined || firstSegment.length === 0) return undefined
  if (!/^\d+$/.test(firstSegment)) return undefined
  return Number.parseInt(firstSegment, 10)
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
