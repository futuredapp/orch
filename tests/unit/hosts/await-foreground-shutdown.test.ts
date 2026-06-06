// Phase 4 unit tests: Host.awaitForegroundShutdown.
//
// Pins the contract:
//   1. Plain mode resolves immediately with `'attach-exited'` (no quit path).
//   2. Two-pane resolves with `'attach-exited'` when attachForeground exits.
//   3. Two-pane resolves with `'quit'` when a `quit` intent fires through
//      the steps view (whichever signal happens first wins; the tagged
//      deferred latches the first resolution).
//
// We drive the tmux host with a FakeTmuxService + FakeProcessService and
// inject `onStepsIntent` to forward simulated quit intents.

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { createPlainHost } from '../../../src/hosts/plain/plain-host.ts'
import { FakeClock, FakeProcessService, type ProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import type { RunId } from '../../../src/state/index.ts'

const RUN_ID = 'r-2026-04-23-700304-kl' as RunId

function makeStderr(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

describe('Host.awaitForegroundShutdown', () => {
  it('resolves immediately under plain mode (no foreground UI to wait on)', async () => {
    const stdout = new Writable({
      write(_c, _e, cb) {
        cb()
      },
    })
    const stderr = makeStderr()
    const host = createPlainHost({
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID,
    })

    // No timer race needed — plain awaits no signal. If this didn't resolve
    // immediately, the test would simply hang.
    await expect(host.awaitForegroundShutdown()).resolves.toBe('attach-exited')
    await host.teardown()
  })

  it('resolves under two-pane when attachForeground exits', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    processService
      .whenForeground(['tmux', '-L', `orch-${RUN_ID}`, 'attach-session', '-t', 'orch'])
      .respondWith({ exitCode: 0 })
    const stderr = makeStderr()

    const host = await createTmuxHost({
      tmux,
      processService: processService as ProcessService,
      clock: new FakeClock(0),
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
      env: {},
      cwd: '/tmp',
      disableStepsView: true,
    })

    const shutdownPromise = host.awaitForegroundShutdown()
    // Until attachForeground completes, awaitForegroundShutdown stays pending.
    // Trigger the attach now; its clean exit (FakeProcessService scripted exit
    // 0) drives the deferred to resolve.
    await host.attachForeground()

    await expect(shutdownPromise).resolves.toBe('attach-exited')
    await host.teardown()
  })

  it('resolves under two-pane when a quit intent fires (before attachForeground returns)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    const stderr = makeStderr()

    // Use a real tempdir so startStepsView can stat the intents file.
    const tmpDir = await fs.mkdtemp('/tmp/orch-shutdown-test-')
    const stateDir = `${tmpDir}/${RUN_ID}`
    await fs.mkdir(stateDir, { recursive: true })

    type IntentLike = { type: 'quit' | 'enter' | 'follow-live' | 'dismiss-banner' }
    let captured: ((intent: IntentLike) => void) | undefined
    const onStepsIntent = (intent: IntentLike): void => {
      captured?.(intent)
    }

    try {
      const host = await createTmuxHost({
        tmux,
        processService: processService as ProcessService,
        clock: new FakeClock(0),
        runId: RUN_ID,
        workflowName: 'demo',
        stderr: stderr.stream,
        skipVersionCheck: true,
        env: {},
        cwd: tmpDir,
        basePath: toPath(tmpDir),
        onStepsIntent,
      })

      const shutdownPromise = host.awaitForegroundShutdown()

      // Append a quit intent to the file the parent watches; the steps-view
      // tail will pick it up and dispatch through the composed onIntent.
      await fs.appendFile(`${stateDir}/tui-intents.ndjson`, `${JSON.stringify({ type: 'quit' })}\n`)

      // The tail polls every 250ms by default; give it a generous beat. The
      // `'quit'` reason latches the deferred so the CLI race can route to
      // teardown+exit instead of awaiting the workflow.
      const reason = await Promise.race([
        shutdownPromise,
        new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 2_000)),
      ])
      expect(reason).toBe('quit')

      await host.teardown()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
