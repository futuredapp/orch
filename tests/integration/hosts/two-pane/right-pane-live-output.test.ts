// COVERED BY → tests-new/unit/hosts/tmux-host.test.ts + tests-new/model/controller/right-pane-controller-sources.test.ts (mixed — see ledger)
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
//   - one `createSession` per autonomous step's per-source session
//     (file-tail source registered on `step:start`)

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
    // The host calls splitPane once: for the visible right pane (R).
    // Per-source sessions are created via `createSession` (auto-synthed pane
    // ids from the fake's createSession counter) — no separate splitPane.
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

describe.skip('two-pane host live path: file-tail source per autonomous step', () => {
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

  it('registers a file-tail source on step:start (createSession for per-source session with tail command) (U4)', async () => {
    const { tmux } = await driveOneAssistantStep(['only thinking'])

    // The host calls createSession for the per-source session
    // (`orch-src-live-plan`) hosting the file-tail. command shape:
    // ['tail', '-n', '5000', '-F', '<tee-path>'].
    const tailCreates = tmux.recordedCalls.filter(
      (c) => c.method === 'createSession' && c.opts.command?.[0] === 'tail',
    )
    expect(tailCreates.length).toBeGreaterThan(0)
    const first = tailCreates[0]
    if (first?.method !== 'createSession') return
    expect(first.opts.session).toBe('orch-src-live-plan')
    const command = first.opts.command ?? []
    expect(command.slice(0, 4)).toEqual(['tail', '-n', '5000', '-F'])
    expect(command[4]).toContain('agents/plan/formatted_output.ansi')
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
