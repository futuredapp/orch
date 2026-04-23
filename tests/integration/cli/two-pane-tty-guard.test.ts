// two-pane TTY guard — exercises the mode-resolver + host-creation guards
// that the CLI installs to keep users out of broken auto-attach states:
//
//   - `--mode=two-pane` without a TTY and without `--no-attach` → exit 2.
//   - `--mode=two-pane --no-attach` without a TTY → accepted (CI path).
//   - `--mode=two-pane` inside a nested tmux (`$TMUX` set) → exit 2 at
//     host creation, before any session work.
//
// These run through the core pieces directly (resolveRunMode, createTmuxHost)
// rather than the full CLI entry point. The CLI entrypoint tests exist
// separately — this file exercises the guards themselves so that a
// refactor that accidentally drops a guard fails here first.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { RunModeError, resolveRunMode } from '../../../src/core/run-mode.ts'
import { createTmuxHost, HostCreationError } from '../../../src/hosts/index.ts'
import { FakeClock, FakeProcessService, type ProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import type { RunId } from '../../../src/state/index.ts'

function bufferStderr(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

describe('two-pane TTY guard (resolveRunMode)', () => {
  it('exits with RunModeError when --mode=two-pane and no TTY and no --no-attach', () => {
    let caught: unknown
    try {
      resolveRunMode({
        flag: 'two-pane',
        ci: false,
        tty: false,
        tmuxAvailable: true,
        tmuxVersionOk: true,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RunModeError)
    expect((caught as Error).message).toContain('requires a TTY')
  })

  it('accepts --mode=two-pane --no-attach without a TTY (CI path)', () => {
    const result = resolveRunMode({
      flag: 'two-pane',
      ci: false,
      tty: false,
      tmuxAvailable: true,
      tmuxVersionOk: true,
      allowHeadlessTwoPane: true,
    })
    expect(result.mode).toBe('two-pane')
    expect(result.source).toBe('flag')
  })
})

describe('two-pane nested-tmux guard (createTmuxHost)', () => {
  it('rejects host creation inside a nested tmux session with actionable guidance', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    let caught: unknown
    try {
      await createTmuxHost({
        tmux,
        processService: new FakeProcessService() as ProcessService,
        clock: new FakeClock(0),
        runId: 'r-2026-04-23-nes001' as RunId,
        workflowName: 'demo',
        stderr: bufferStderr(),
        skipVersionCheck: true,
        env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HostCreationError)
    const msg = (caught as Error).message
    expect(msg).toContain('already inside a tmux session')
    expect(msg).toContain('--mode=plain')
  })

  it('bypasses the nested-tmux guard when skipAttach is true (headless --no-attach in nested tmux)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const host = await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: 'r-2026-04-23-nes002' as RunId,
      workflowName: 'demo',
      stderr: bufferStderr(),
      skipVersionCheck: true,
      env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      skipAttach: true,
    })

    expect(host.mode).toBe('two-pane')
    await host.teardown()
  })
})
