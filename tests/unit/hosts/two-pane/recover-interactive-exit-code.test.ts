// Unit coverage for the interactive exit-code recovery.
//
// tmux's `pane-died` hook channel carries no exit code, but `remain-on-exit on`
// keeps the dead pane's `#{pane_dead_status}` readable until `unregisterSource`
// reaps it. `recoverInteractiveExitCode` reads that status (reusing the
// liveness-poll's read when it already has one) so a non-autoStop interactive
// step that exits non-zero — e.g. the predictable fake's `fail` op — lands the
// step `failed` instead of being silently treated as a clean exit.
//
// FakeTmuxService.setDisplayResult scripts the `#{pane_dead},#{pane_dead_status}`
// probe; an unscripted probe throws, modelling a vanished pane.

import { describe, expect, it } from 'bun:test'
import { recoverInteractiveExitCode } from '../../../../src/hosts/two-pane/tmux-host.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'

const SOCKET = socketName('orch-test')
const PANE = paneId('%7')

describe('recoverInteractiveExitCode', () => {
  it('reuses the liveness-poll status without probing tmux again', async () => {
    const tmux = new FakeTmuxService()

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, '7')

    expect(code).toBe(7)
    expect(tmux.recordedCalls.filter((c) => c.method === 'displayMessage')).toHaveLength(0)
  })

  it('probes #{pane_dead_status} and returns a non-zero code (simulated failure)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setDisplayResult('1,1') // dead pane, exit status 1

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, undefined)

    expect(code).toBe(1)
  })

  it('probes and returns 0 for a clean dead pane', async () => {
    const tmux = new FakeTmuxService()
    tmux.setDisplayResult('1,0')

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, undefined)

    expect(code).toBe(0)
  })

  it('returns 0 when the pane is still reported alive', async () => {
    const tmux = new FakeTmuxService()
    tmux.setDisplayResult('0,')

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, undefined)

    expect(code).toBe(0)
  })

  it('returns 0 when the pane has vanished (probe throws)', async () => {
    const tmux = new FakeTmuxService()
    // No displayMessage scripted → FakeTmuxService throws → probe returns 'gone'.

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, undefined)

    expect(code).toBe(0)
  })

  it('treats an empty polled status as a clean exit (0)', async () => {
    const tmux = new FakeTmuxService()

    const code = await recoverInteractiveExitCode(tmux, SOCKET, PANE, '')

    expect(code).toBe(0)
  })
})
