// MIGRATED → tests-new/integration/hosts/two-pane/two-pane-interactive-session-lost.test.ts
// Bug repro: when the tmux session has died externally (e.g. the user killed
// the tmux server while attached, then `awaitForegroundShutdown` settled with
// `'attach-exited'` and the workflow advanced to the next interactive step),
// the next `host.runInteractive(...)` calls `controller.registerSource(...)`
// which issues `tmux split-window` against the dead socket. tmux exits with
// `(No such file or directory)`; `RealTmuxService.splitPane` throws
// `TmuxCommandError`. That error escapes `runInteractive` un-wrapped, the
// workflow re-throws it as a `crashed` failure, and `mapRunError` doesn't
// know about it — so it surfaces to the user as an uncaught rejection that
// crashes Bun with a stack trace instead of a clean failure summary.
//
// This test asserts the host translates that condition into a typed
// `HostUnavailableError` from `src/hosts/host.ts`, which the CLI's
// `mapRunError` can handle as a graceful failure.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName as makeStepName } from '../../../src/core/types.ts'
import { HostUnavailableError } from '../../../src/hosts/host.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { FakeClock, FakeFsService, FakeProcessService, path } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-05-21-993100-zz' as RunId

describe.skip('two-pane interactive step — tmux session lost externally', () => {
  it('translates the dead-socket TmuxCommandError into a HostUnavailableError instead of letting it escape un-wrapped', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const basePath = path('/state')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    // First splitPane → visible right pane (placeholder cat). This succeeds —
    // the host is being constructed BEFORE the session is killed.
    tmux.nextPaneId(paneId('%7'))

    const stateStore = new FileStateStore({ fs, basePath })

    const host = await createTmuxHost({
      tmux,
      fs,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'session-lost-repro',
      stderr: stderr.stream,
      skipVersionCheck: true,
      basePath,
      stateStore,
      disableStepsView: true,
    })

    // Simulate: the user detached and tmux server died between the previous
    // step finishing and the next interactive step starting. From this point
    // on EVERY tmux call against this socket fails — that's the real-world
    // failure mode we're guarding against (incident r-2026-05-22-093650-j0).
    const socket = (
      tmux.recordedCalls.find((c) => c.method === 'createSession') as {
        opts: { socket: import('../../../src/services/tmux/index.ts').SocketName }
      }
    ).opts.socket
    tmux.markSocketLost(socket)

    let caught: unknown
    try {
      await host.runInteractive({
        argv: [':fake:', '--mode', 'interactive'],
        env: {},
        cwd: path('/workspace'),
        stepName: makeStepName('deepen-brainstorm'),
      })
    } catch (err) {
      caught = err
    } finally {
      await host.teardown()
    }

    // The bug: the un-translated TmuxCommandError escapes runInteractive and
    // crashes the CLI with an unhandled rejection stack trace. After the fix,
    // runInteractive should detect the dead session and throw a typed
    // HostUnavailableError that mapRunError can render as a clean failure.
    expect(caught).toBeInstanceOf(HostUnavailableError)
    expect((caught as Error).message).toMatch(/tmux|session|host/i)
  })
})
