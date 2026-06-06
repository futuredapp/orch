// COVERED BY → tests-new/lifecycle/q-intent--tears-down-cleanly.test.ts (+ lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) — TUI-mounted-through-completion / pending-until-quit / teardown-order are PROCESS lifecycle plumbing (FakeTmux mocked e2e, passes if pane empty)
// Phase 4 mocked e2e: drive a multi-step workflow through createTmuxHost +
// FakeTmuxService + FakeProcessService end-to-end and assert that:
//   1. The host stays alive through workflow completion.
//   2. After completion, awaitForegroundShutdown stays pending until a quit
//      intent fires.
//   3. Teardown wipes the session in the canonical order.
//
// Always runs (no real CLI required).

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

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-eor-e2e-mocked-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

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

describe.skip('steps-tui mocked e2e', () => {
  it('keeps the TUI mounted through workflow completion until quit fires', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const processService = new FakeProcessService()
    const stderr = makeStderr()
    const stateDir = `${tmpDir}/${RUN_ID}`
    await fs.mkdir(stateDir, { recursive: true })

    const intentsSeen: string[] = []
    const host = await createTmuxHost({
      tmux,
      processService: processService as ProcessService,
      clock: new FakeClock(0),
      runId: RUN_ID,
      workflowName: 'eor-e2e',
      stderr: stderr.stream,
      skipVersionCheck: true,
      env: {},
      cwd: tmpDir,
      basePath: toPath(tmpDir),
      onStepsIntent: (intent) => intentsSeen.push(intent.type),
    })

    // Simulate a multi-step workflow finishing without intervention.
    const workflowPromise = (async (): Promise<void> => {
      // emulate work on three steps
      for (const _step of ['plan', 'work', 'commit']) {
        await new Promise((r) => setTimeout(r, 5))
      }
    })()

    await workflowPromise

    // Workflow done. The host has not been torn down: kill-session must NOT
    // have fired yet.
    expect(tmux.recordedCalls.filter((c) => c.method === 'killSession')).toHaveLength(0)

    // awaitForegroundShutdown stays pending until a quit intent fires.
    const sentinel = Symbol('pending')
    const winner = await Promise.race([
      host.awaitForegroundShutdown().then(() => 'shutdown'),
      new Promise<typeof sentinel>((r) => setTimeout(() => r(sentinel), 200)),
    ])
    expect(winner).toBe(sentinel)

    await fs.appendFile(`${stateDir}/tui-intents.ndjson`, `${JSON.stringify({ type: 'quit' })}\n`)
    await Promise.race([
      host.awaitForegroundShutdown(),
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 2_000)),
    ])

    // Now teardown — the visible orch session must be killed exactly once.
    // (Per-source sessions live under `orch-src-*` and are killed first by
    // the controller; this assertion targets only the visible `orch` kill.)
    await host.teardown()
    const killOrch = tmux.recordedCalls.filter(
      (c) => c.method === 'killSession' && c.opts.session === 'orch',
    )
    expect(killOrch).toHaveLength(1)
    expect(intentsSeen).toContain('quit')
  })
})
