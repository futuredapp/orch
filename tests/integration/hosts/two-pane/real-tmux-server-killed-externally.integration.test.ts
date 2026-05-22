// Tier-1 fail-first repro of incident r-2026-05-22-093650-j0: the tmux
// server died externally mid-run; orch's next `runInteractive` call hit a
// dead socket and surfaced an uncaught `TmuxCommandError`.
//
// What we pin here:
//   1. After an external `kill-server`, `host.runInteractive(...)` throws
//      `HostUnavailableError`, not a raw `TmuxCommandError`.
//   2. `host.probeReachability()` (the launcher's "should I print 'run
//      continues in background'?" probe) reports `{ reachable: false }`
//      after the kill.
//   3. The host writes a `tmuxReachabilityProbeFailed:true` lifecycle event
//      so post-mortem analysis can tell "tmux died externally" from "step
//      blew up".
//   4. `host.teardown()` is idempotent against a dead server — no
//      unhandled rejection, no orphan tmux processes left behind on the
//      socket.
//
// Why Tier-1 (real tmux): the mocked variant
// `tests/integration/hosts/two-pane-interactive-session-lost.test.ts`
// covers the typed-error contract. This test covers the part that only
// real tmux can exercise: every subsequent command against the same
// socket fails with the canonical macOS shape and the host's classifier
// must catch it.

import { afterEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stepName as makeStepName } from '../../../../src/core/types.ts'
import { HostUnavailableError } from '../../../../src/hosts/host.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown().catch(() => {})
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose().catch(() => {})
  fixturesToDispose = []
})

async function killTmuxServerExternally(socket: string): Promise<void> {
  // External kill — bypasses orch's TmuxService entirely. Simulates the user
  // (or the OS) terminating the tmux server underneath a running orch
  // process. `kill-server` is the heaviest hammer; it removes the socket
  // file too, so the next orch tmux call gets "No such file or directory".
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

async function countOrphanTmuxProcessesForSocket(socket: string): Promise<number> {
  // Best-effort orphan check: ask ps for any tmux process arg-matching our
  // socket name. Returns the count. Zero means clean teardown.
  const proc = Bun.spawn(['pgrep', '-fl', `tmux.*${socket}`], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return stdout.split('\n').filter((line) => line.trim().length > 0).length
}

describe.skipIf(!tmuxAvailable)('two-pane host — tmux server killed externally mid-run', () => {
  it('translates the dead socket into HostUnavailableError and reports unreachable', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnessesToTeardown.push(harness)

    // Baseline: the host is reachable while tmux is alive.
    const before = await harness.host.probeReachability()
    expect(before.reachable).toBe(true)

    // External kill — mimics the production failure (server dies between
    // steps, orch is idle, the user sees nothing).
    await killTmuxServerExternally(String(fixture.socket))

    // Now probeReachability must report unreachable. This is the contract
    // the launcher (`execute-with-attach`) consults to decide whether to
    // print the misleading "run continues in background" hint.
    const after = await harness.host.probeReachability()
    expect(after.reachable).toBe(false)
    expect(after.reason).toMatch(/tmux|session/i)

    // The next interactive step's runInteractive surfaces a typed
    // HostUnavailableError, not a raw TmuxCommandError.
    let caught: unknown
    try {
      await harness.host.runInteractive({
        argv: ['cat'],
        env: {},
        cwd: toPath(String(fixture.stateBase)),
        stepName: makeStepName('deepen-brainstorm'),
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HostUnavailableError)
    expect((caught as Error).message).toMatch(/tmux|session|host/i)
  }, 30_000)

  it('records tmuxReachabilityProbeFailed in the lifecycle log on the failure path', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    harnessesToTeardown.push(harness)

    await killTmuxServerExternally(String(fixture.socket))

    // Trigger the host's classification path by attempting an interactive
    // call. The host's catch block writes
    // `tmuxReachabilityProbeFailed:true` via `tmuxReachability()` when
    // `isSessionLostError(err)` matches.
    await harness.host
      .runInteractive({
        argv: ['cat'],
        env: {},
        cwd: toPath(String(fixture.stateBase)),
        stepName: makeStepName('deepen-brainstorm'),
      })
      .catch(() => {
        /* expected — assertion above already pinned the typed error shape */
      })

    // Logs may close asynchronously; close the logger to flush, then read.
    await harness.logger.close().catch(() => {})

    const lifecyclePath = join(
      String(fixture.stateBase),
      '.orch',
      'state',
      String(fixture.runId),
      'logs',
      'lifecycle.ndjson',
    )
    const contents = await readFile(lifecyclePath, 'utf8')
    // The contract: somewhere in the lifecycle log, the host recorded the
    // session-lost diagnostic. The host emits one of two shapes depending
    // on what `tmuxReachability()` itself could observe at the moment of
    // failure:
    //   - probe succeeded → `tmuxServerReachable:false` (the common case
    //     after a clean `kill-server`)
    //   - probe also threw → `tmuxReachabilityProbeFailed:true`
    // Both are valid post-mortem signals; we accept either.
    expect(contents).toMatch(/tmuxReachabilityProbeFailed":\s*true|tmuxServerReachable":\s*false/)
    // The session-lost classification fired and was attached to the
    // interactive-register-failed event.
    expect(contents).toMatch(/isSessionLost":\s*true/)
    expect(contents).toMatch(/interactive-register-failed/)
  }, 30_000)

  it('host.teardown() against a dead server completes without throwing', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: true })
    // Don't queue this harness's teardown via afterEach — we'll call it
    // explicitly under the dead-server condition and want to observe the
    // result here.

    await killTmuxServerExternally(String(fixture.socket))

    let teardownError: unknown
    try {
      await harness.host.teardown()
    } catch (err) {
      teardownError = err
    }
    expect(teardownError).toBeUndefined()

    // No orphan tmux processes survived for this socket.
    const orphans = await countOrphanTmuxProcessesForSocket(String(fixture.socket))
    expect(orphans).toBe(0)
  }, 30_000)
})
