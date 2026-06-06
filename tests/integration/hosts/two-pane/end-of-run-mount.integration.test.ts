// COVERED BY → tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts (+ lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) — host-stays-alive-past-completion / idempotent-teardown / quit-fires-once are PROCESS lifecycle plumbing
// Phase 4 integration: end-of-run mount lifecycle (mocked tmux).
//
// Drives a tmux host with a FakeTmuxService + FakeProcessService and asserts:
//   1. `host.teardown()` is NOT called by workflow completion alone — the
//      controller stays alive past it (the steps view stays mounted past
//      end-of-run so the user sees the summary).
//   2. `awaitForegroundShutdown` resolves on a `quit` intent.
//   3. Idempotent teardown: calling teardown twice is a no-op the second
//      time (no double kill-session).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createTmuxHost } from '../../../../src/hosts/index.ts'
import {
  FakeClock,
  FakeProcessService,
  type ProcessService,
} from '../../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type { RunId } from '../../../../src/state/index.ts'

const RUN_ID = 'r-2026-05-05-100000-bb' as RunId

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

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-eor-mount-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe.skip('end-of-run mount (mocked tmux)', () => {
  it('keeps the host alive past workflow completion until awaitForegroundShutdown fires', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    const stderr = makeStderr()
    const stateDir = `${tmpDir}/${RUN_ID}`
    await fs.mkdir(stateDir, { recursive: true })

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
      onStepsIntent: () => {
        /* no-op for this test */
      },
    })

    // Simulate workflow completion: it merely settles a Promise. The host
    // does not learn about it. Teardown only fires when the CLI calls it.
    const workflow = Promise.resolve()
    await workflow

    // The shutdown promise has not yet fired — quit intent not yet sent and
    // attachForeground not called. Use a short race with a timeout to assert
    // it stays pending.
    const sentinel = Symbol('pending')
    const winner = await Promise.race([
      host.awaitForegroundShutdown().then(() => 'shutdown'),
      new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 200)),
    ])
    expect(winner).toBe(sentinel)

    // Now fire a quit intent — shutdown resolves.
    await fs.appendFile(`${stateDir}/tui-intents.ndjson`, `${JSON.stringify({ type: 'quit' })}\n`)
    await Promise.race([
      host.awaitForegroundShutdown(),
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 2_000)),
    ])

    await host.teardown()
  })

  it('tears down idempotently — second teardown is a no-op', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    const stderr = makeStderr()
    const stateDir = `${tmpDir}/${RUN_ID}`
    await fs.mkdir(stateDir, { recursive: true })

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
      onStepsIntent: () => {},
    })

    await host.teardown()
    const killSessionsBefore = tmux.recordedCalls.filter((c) => c.method === 'killSession').length

    // Second teardown — must not double-kill.
    await host.teardown()
    const killSessionsAfter = tmux.recordedCalls.filter((c) => c.method === 'killSession').length

    expect(killSessionsAfter).toBe(killSessionsBefore)
  })

  it('quit intent fires the canonical shutdown signal exactly once', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    const stderr = makeStderr()
    const stateDir = `${tmpDir}/${RUN_ID}`
    await fs.mkdir(stateDir, { recursive: true })

    const intents: string[] = []
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
      onStepsIntent: (intent) => intents.push(intent.type),
    })

    const shutdownDone = host.awaitForegroundShutdown()
    await fs.appendFile(`${stateDir}/tui-intents.ndjson`, `${JSON.stringify({ type: 'quit' })}\n`)

    await Promise.race([
      shutdownDone,
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 2_000)),
    ])

    expect(intents).toContain('quit')

    // A second await on the same promise must resolve cheaply (no replay)
    // and surface the same `'quit'` reason — the tagged deferred latches
    // its first resolution.
    await expect(host.awaitForegroundShutdown()).resolves.toBe('quit')

    await host.teardown()
  })
})
