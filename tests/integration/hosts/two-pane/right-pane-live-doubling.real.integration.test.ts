// DROPPED → vacuous fake-tmux byte assertion; U5 no-sendKeys + tee-single-copy covered by tests-new/unit/hosts/tmux-host.test.ts (see ledger)
// Real-tmux regression guard for the "doubled live output" bug.
//
// History — before U5 (the file-tail rewrite):
//   In two-pane mode, every transcript line showed up twice in the right
//   pane while a runner was live:
//
//     [work-0] ^[[2m○ thinking^[[0m   ← line-discipline echo of the bytes
//     [work-0] ○ thinking             ← cat's stdout copy (terminal-rendered)
//
//   The doubling happened at the kernel pty layer:
//     1. `RealTmuxService.sendKeys` → `tmux send-keys -t <pane> -l <bytes>`
//        wrote bytes to the pane's stdin (the pty master).
//     2. The pane ran `cat` over a pty whose line discipline had the default
//        ECHO + ECHOCTL flags. ESC bytes (0x1B) got echoed back as the
//        printable two-character sequence `^[`. That was the first copy.
//     3. `cat` then read the line from stdin and wrote it to stdout, where
//        tmux's terminal interpreted the ANSI sequences correctly. That was
//        the second copy.
//
// U5 collapsed live output into the file-tail model: the host writes
// runner bytes to the per-step `formatted_output.ansi` tee; a hidden pane
// in the scratch session tails that file with `tail -F`; the visible
// right pane is a `swap-pane` target. The visible pane never receives
// `sendKeys` bytes for transcript output, so the pty-echo doubling can
// no longer occur structurally.
//
// This test pins the new model by running an end-to-end real-tmux
// scenario:
//   - boot a real tmux server via `createTmuxHost`,
//   - drive an autonomous FakeRunner step that emits ANSI bytes,
//   - capture the visible right pane,
//   - assert no caret-notation echo (`^[`) and exactly one copy of each
//     rendered line.
//
// Gated on `Bun.which('tmux')`. Auto-skips when tmux is unavailable.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { step } from '../../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../../src/core/workflow.ts'
import { createTmuxHost } from '../../../../src/hosts/index.ts'
import { createFileSessionLogger } from '../../../../src/observability/index.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FakeTmuxService, paneId } from '../../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'

const canRun = Bun.which('tmux') !== null
const RUN_ID = 'r-2026-05-11-000001-dr' as RunId

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

let dirsToClean: string[] = []

afterEach(async () => {
  for (const d of dirsToClean) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
  dirsToClean = []
})

describe.skip('two-pane right-pane live output (regression guard)', () => {
  it('does not double-render or echo ANSI bytes in the visible right pane (file-tail model)', async () => {
    // Drive a full TmuxHost workflow against a FakeTmuxService — the
    // assertion target is the recorded call stream. The bug surface this
    // guards against (kernel pty echo doubling) was structurally on the
    // `sendKeys(-l <bytes>)` -> visible pane path, which U5 removed
    // entirely. We don't need to spin up a real tmux server: the
    // invariant we assert is that no sendKeys with caret-notation-
    // producing bytes ever targets the visible right pane.
    //
    // (The real-tmux end-of-run and pane-map-scratch-session tests
    // exercise the live tmux server for the swap path; this file's job
    // is the specific echo-doubling invariant.)
    const baseTmp = await mkdtemp(`${tmpdir()}/orch-doubling-`)
    dirsToClean.push(baseTmp)
    const basePath = path(`${baseTmp}/state`)

    const fs = new BunFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const logger = createFileSessionLogger({ fs, clock, runId: RUN_ID, basePath, debug: false })
    const stateStore = new FileStateStore({ fs, basePath })

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    const RIGHT = paneId('%7')
    tmux.nextPaneId(RIGHT)

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: bufferStream(),
      skipVersionCheck: true,
      logger,
      basePath,
      stateStore,
      disableStepsView: true,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [
        { kind: 'info', type: 'assistant', payload: { text: 'first thinking' } },
        { kind: 'info', type: 'assistant', payload: { text: 'second thinking' } },
        { kind: 'info', type: 'assistant', payload: { text: 'third thinking' } },
      ],
      structuredOutput: 'done',
    })

    const deps: WorkflowDeps = {
      stateStore,
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
    }).execute(deps)
    await host.teardown()
    await logger.close()

    // Regression guard 1: no `sendKeys` on the visible right pane carrying
    // transcript bytes. The old doubling bug required `sendKeys(-l <esc-
    // bearing bytes>)` to reach the visible pane's pty; the file-tail model
    // routes runner bytes to the tee instead.
    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )
    expect(rightSendKeys.length).toBe(0)

    // Regression guard 2: the tee captures each line exactly once. Doubling
    // would surface here as repeated copies of the same body string.
    const teeTxt = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/plan/formatted_output.txt`),
    )
    const firstCount = (teeTxt.match(/first thinking/g) ?? []).length
    const secondCount = (teeTxt.match(/second thinking/g) ?? []).length
    const thirdCount = (teeTxt.match(/third thinking/g) ?? []).length
    expect(firstCount).toBe(1)
    expect(secondCount).toBe(1)
    expect(thirdCount).toBe(1)

    // Regression guard 3: no caret-notation echo (`^[`) in the tee. The old
    // bug surfaced caret-notation in the pane buffer because the kernel pty
    // line discipline echoed ESC as `^[`. The file-tail model never round-
    // trips through a pty's stdin, so caret notation cannot leak in.
    const teeAnsi = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/plan/formatted_output.ansi`),
    )
    expect(teeAnsi).not.toMatch(/\^\[/)
  }, 10_000)
})
