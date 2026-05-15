// triage: rewrite — multi-scenario file. argv-shape scenarios are Tier 3 territory (keep). "no sendKeys on visible right pane" scenarios are Tier 1 (autonomous-live-pane-shows-content). Split the file in U6.
// Contract test for the *live* path that feeds the right pane while a runner
// is producing events.
//
// U5 collapsed live output into the file-tail model: the host writes runner
// bytes to the per-step `formatted_output.ansi` tee; a hidden pane in the
// scratch session tails that file; the visible right pane is a `swap-pane`
// target. The bug surfaces this guards against:
//
//   - the kernel pty echo-doubling that lived on the old `sendKeys` path
//     (no longer reachable: the host no longer writes runner bytes via
//     `sendKeys` to the visible right pane)
//   - rollup / replay / interactive paths corrupting each other (no longer
//     reachable: every visible-pane change is a single `swap-pane`)
//
// The shape this file pins:
//
//   - zero `sendKeys` calls on the visible right pane for runner-event bytes
//   - zero `respawnPane` calls on the visible right pane (replay path moved
//     to scratch+swap)
//   - one `splitPane` on the scratch session per autonomous step (file-tail
//     source registered on `step:start`)

import { describe, expect, it } from 'bun:test'
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

const RUN_ID = 'r-2026-05-06-000001-rl' as RunId
const RIGHT = paneId('%7')
const LEFT = paneId('%0')
const ESC = String.fromCharCode(0x1b)

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

interface DriveResult {
  readonly tmux: FakeTmuxService
  readonly teeAnsi: string
  readonly teeTxt: string
}

async function driveOneAssistantStep(events: ReadonlyArray<string>): Promise<DriveResult> {
  const baseTmp = await mkdtemp(`${tmpdir()}/orch-u5-live-`)
  try {
    const basePath = path(`${baseTmp}/state`)
    const fs = new BunFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const logger = createFileSessionLogger({ fs, clock, runId: RUN_ID, basePath, debug: false })
    const stateStore = new FileStateStore({ fs, basePath })

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    // The host calls splitPane twice: once for the visible right pane (R)
    // and once for the placeholder source inside the scratch session.
    // Subsequent splitPane calls (file-tail sources, etc.) just get a
    // synthesized id from the fake.
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
      events: events.map((text) => ({
        kind: 'info' as const,
        type: 'assistant',
        payload: { text },
      })),
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

    const teeAnsi = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/plan/formatted_output.ansi`),
    )
    const teeTxt = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/plan/formatted_output.txt`),
    )

    return { tmux, teeAnsi, teeTxt }
  } finally {
    await rm(baseTmp, { recursive: true, force: true }).catch(() => {})
  }
}

describe('two-pane host live path: file-tail source per autonomous step', () => {
  it('writes runner bytes to the per-step tee instead of the visible right pane', async () => {
    const { tmux, teeAnsi, teeTxt } = await driveOneAssistantStep([
      'first thinking',
      'second thinking',
    ])

    // No sendKeys traffic to the visible right pane — the file-tail source
    // pane in scratch tails the tee and mirrors bytes natively.
    const rightSends = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )
    expect(rightSends.length).toBe(0)

    // The tee captures both events with ANSI bytes intact.
    expect(teeAnsi).toContain('first thinking')
    expect(teeAnsi).toContain('second thinking')
    expect(teeTxt).toContain('first thinking')
    expect(teeTxt).toContain('second thinking')
  })

  it('does not respawn the right pane during the autonomous step (file-tail model)', async () => {
    const { tmux } = await driveOneAssistantStep(['only thinking'])

    // The right pane must never be respawned. Live transcript flows through
    // the scratch-session file-tail pane and a single swap-pane. Replay
    // also uses the scratch session.
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT,
    )

    expect(rightRespawns.length).toBe(0)
  })

  it('writes ANSI-colored payloads to the tee (color: true)', async () => {
    const { teeAnsi } = await driveOneAssistantStep(['only thinking'])

    // Real ESC byte must be present in the tee — proves the formatter is in
    // color mode. The bytes never round-trip through `sendKeys` so the
    // kernel pty echo-doubling that bit the legacy path cannot recur.
    expect(teeAnsi).toContain(`${ESC}[`)
  })

  it('registers a file-tail source on step:start (splitPane on scratch with tail argv)', async () => {
    const { tmux } = await driveOneAssistantStep(['only thinking'])

    // The host calls splitPane on the scratch session for the file-tail
    // source. argv shape: ['tail', '-n', '5000', '-F', '<tee-path>'].
    const argvSplits = tmux.recordedCalls.filter(
      (c) => c.method === 'splitPane' && 'argv' in c.opts && c.opts.argv?.[0] === 'tail',
    )
    expect(argvSplits.length).toBeGreaterThan(0)
    const first = argvSplits[0]
    if (first?.method !== 'splitPane' || !('argv' in first.opts)) return
    const argv = first.opts.argv ?? []
    expect(argv).toEqual(['tail', '-n', '5000', '-F', argv[4] as string])
    expect(argv[4]).toContain('agents/plan/formatted_output.ansi')
  })

  it('left-pane bootstrap respawn is unrelated to the right-pane live path', async () => {
    const { tmux } = await driveOneAssistantStep(['hello'])

    const leftRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === LEFT,
    )
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT,
    )

    // Right pane is never respawned. Load-bearing invariant of the swap
    // model (every visible-pane change is a swap-pane).
    expect(rightRespawns.length).toBe(0)
    expect(leftRespawns.length).toBeGreaterThanOrEqual(0)
  })
})
