// Unit coverage for the interactive completion wait's liveness backstop.
//
// The wait's primary signal is the unbounded `pane-died` hook channel. Under
// host contention that signal can be lost or delayed long after the pane is
// already dead, which used to leave the wait parked until the caller's timeout
// fired with no diagnosis (the two-pane-sequential-runs flake, 2026-05-26).
// `awaitInteractivePaneExit` adds a slow liveness poll that observes pane death
// directly — without ever failing a still-live pane.
//
// FakeTmuxService.holdNextWaitFor() models the lost-hook case; FakeClock drives
// the poll deterministically via advance().

import { describe, expect, it } from 'bun:test'
import { awaitInteractivePaneExit } from '../../../../src/hosts/two-pane/tmux-host.ts'
import { FakeClock } from '../../../../src/services/clock/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'

const SOCKET = socketName('orch-test')
const PANE = paneId('%7')
const CHANNEL = 'pane-exit-%7'
const POLL_MS = 1000

// Yield to the macrotask queue so all pending microtasks (the poll's awaited
// displayMessage, the race settle) drain before the next advance().
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function driveUntilSettled(
  clock: FakeClock,
  settled: () => boolean,
  maxTicks = 10,
): Promise<void> {
  for (let i = 0; i < maxTicks && !settled(); i++) {
    clock.advance(POLL_MS)
    await flush()
  }
}

describe('awaitInteractivePaneExit', () => {
  it('resolves via the pane-died hook when the hook signal arrives', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(0)

    const outcome = await awaitInteractivePaneExit(tmux, SOCKET, PANE, CHANNEL, clock, POLL_MS)

    expect(outcome.via).toBe('hook')
  })

  it('falls back to the liveness poll when the hook signal is lost, reporting the dead status', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(0)
    tmux.holdNextWaitFor() // the hook signal never arrives
    tmux.setDisplayResult('1,0') // pane is dead with exit status 0

    let outcome: Awaited<ReturnType<typeof awaitInteractivePaneExit>> | undefined
    const pending = awaitInteractivePaneExit(tmux, SOCKET, PANE, CHANNEL, clock, POLL_MS).then(
      (o) => {
        outcome = o
      },
    )
    await driveUntilSettled(clock, () => outcome !== undefined)
    await pending

    expect(outcome?.via).toBe('liveness-poll')
    expect(outcome?.deadStatus).toBe('0')
  })

  it('releases the parked hook waiter via signalChannel when the poll wins', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(0)
    tmux.holdNextWaitFor()
    tmux.setDisplayResult('1,0')

    let done = false
    const pending = awaitInteractivePaneExit(tmux, SOCKET, PANE, CHANNEL, clock, POLL_MS).then(
      () => {
        done = true
      },
    )
    await driveUntilSettled(clock, () => done)
    await pending

    const signalled = tmux.recordedCalls.filter((c) => c.method === 'signalChannel')
    expect(signalled).toHaveLength(1)
    expect(signalled[0]?.opts.channel).toBe(CHANNEL)
  })

  it('keeps waiting while the pane is alive and never fails a live pane', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(0)
    tmux.holdNextWaitFor()
    // Two probes see a live pane, the third sees it dead.
    tmux.setDisplayResult('0,')
    tmux.setDisplayResult('0,')
    tmux.setDisplayResult('1,0')

    let outcome: Awaited<ReturnType<typeof awaitInteractivePaneExit>> | undefined
    const pending = awaitInteractivePaneExit(tmux, SOCKET, PANE, CHANNEL, clock, POLL_MS).then(
      (o) => {
        outcome = o
      },
    )

    // After one tick the pane is still alive — the wait must not have settled.
    clock.advance(POLL_MS)
    await flush()
    expect(outcome).toBeUndefined()

    await driveUntilSettled(clock, () => outcome !== undefined)
    await pending

    expect(outcome?.via).toBe('liveness-poll')
  })

  it('treats a vanished pane (display-message throws) as exited', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(0)
    tmux.holdNextWaitFor()
    // No displayMessage scripted → FakeTmuxService throws → probe returns 'gone'.

    let outcome: Awaited<ReturnType<typeof awaitInteractivePaneExit>> | undefined
    const pending = awaitInteractivePaneExit(tmux, SOCKET, PANE, CHANNEL, clock, POLL_MS).then(
      (o) => {
        outcome = o
      },
    )
    await driveUntilSettled(clock, () => outcome !== undefined)
    await pending

    expect(outcome?.via).toBe('liveness-poll')
    expect(outcome?.deadStatus).toBeUndefined()
  })
})
