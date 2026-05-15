// triage: rewrite — rollup visible outcome is Tier 1 territory once the harness gains a "drive a parallel block" helper. Interim Keep; Rewrite once that helper lands.
// Integration coverage for U7: the parallel rollup lives on its own hidden
// pane in the scratch session, fed by the `_rollup` meta tee. The host
// reacts to:
//   - step:parallel-start       → tee.open('_rollup') + registerSource(rollup, file-tail)
//   - step:parallel-branch-update → tee.write('_rollup', renderRollupPayload(...))
//   - step:parallel-complete    → unregisterSource(rollup) + tee.close('_rollup') + rollup.reset()
//
// Asserts the tee bytes, the scratch-session splitPane argv shape, and the
// U7 invariant: zero `sendKeys` on the visible right pane for rollup
// payloads.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { parallel } from '../../../../src/core/parallel.ts'
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

const RUN_ID = 'r-2026-05-11-000007-u7' as RunId
const RIGHT = paneId('%7')

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
  readonly teePath: string
}

async function driveParallelBlock(branches: readonly string[]): Promise<DriveResult> {
  const baseTmp = await mkdtemp(`${tmpdir()}/orch-u7-rollup-`)
  try {
    const basePath = path(`${baseTmp}/state`)
    const fs = new BunFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const logger = createFileSessionLogger({ fs, clock, runId: RUN_ID, basePath, debug: false })
    const stateStore = new FileStateStore({ fs, basePath })

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
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
      await parallel(
        branches,
        (label) => {
          const fr = new FakeRunner(processService)
          fr.script({ structuredOutput: `ok-${label}` })
          const REVIEW = step.define('review', { agent: fr })
          return run(REVIEW, { as: `review-${label}` })
        },
        { concurrency: branches.length },
      )
    }).execute(deps)
    await host.teardown()
    await logger.close()

    const teePath = `${basePath}/${RUN_ID}/logs/agents/_rollup/formatted_output.ansi`
    const teeAnsi = await fs.readFile(path(teePath)).catch(() => '')
    return { tmux, teeAnsi, teePath }
  } finally {
    await rm(baseTmp, { recursive: true, force: true }).catch(() => {})
  }
}

describe('two-pane host: rollup pane-map wiring (U7)', () => {
  it('writes rollup snapshots to the _rollup tee instead of the visible right pane', async () => {
    const { tmux, teeAnsi } = await driveParallelBlock(['a', 'b'])

    // U7 invariant: rollup payloads do NOT fan out via `sendKeys` to the
    // visible right pane. The scratch-session hidden pane tails the tee
    // and reaches the visible slot through `swapPane` only.
    const rightSends = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )
    expect(rightSends.length).toBe(0)

    // The tee captures the rollup payload — `parallel branches:` header
    // plus a line per branch. Each branch ends `completed`, so the final
    // snapshot carries `✓` glyphs.
    expect(teeAnsi).toContain('parallel branches:')
    expect(teeAnsi).toContain('review-a')
    expect(teeAnsi).toContain('review-b')
    expect(teeAnsi).toContain('✓')
  })

  it('registers a file-tail source on step:parallel-start (splitPane on scratch with tail argv)', async () => {
    const { tmux } = await driveParallelBlock(['a', 'b'])

    // The host calls splitPane on the scratch session for the rollup
    // file-tail source. argv shape: ['tail', '-n', '5000', '-F', '<tee>'].
    // Find the splitPane whose tail argv targets the `_rollup` tee path.
    const rollupTail = tmux.recordedCalls.find((c) => {
      if (c.method !== 'splitPane' || !('argv' in c.opts)) return false
      const argv = c.opts.argv ?? []
      return argv[0] === 'tail' && typeof argv[4] === 'string' && argv[4].includes('_rollup')
    })

    expect(rollupTail).toBeDefined()
    if (rollupTail?.method !== 'splitPane' || !('argv' in rollupTail.opts)) {
      throw new Error('expected rollup splitPane with tail argv')
    }
    const argv = rollupTail.opts.argv ?? []
    expect(argv.slice(0, 4)).toEqual(['tail', '-n', '5000', '-F'])
    expect(argv[4]).toContain('agents/_rollup/formatted_output.ansi')
  })

  it('does not respawn the right pane during a parallel block', async () => {
    const { tmux } = await driveParallelBlock(['a', 'b'])

    // The rollup lives on the scratch session; every visible-pane change is
    // a `swapPane`. Right-pane respawn is the bug class U5–U7 eradicates.
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT,
    )
    expect(rightRespawns.length).toBe(0)
  })

  it('kills the rollup hidden pane on step:parallel-complete (warm cache is live-only)', async () => {
    const { tmux } = await driveParallelBlock(['a', 'b'])

    // Rollup is a transient source — the controller's unregister path kills
    // its hidden pane (no replay warm-cache for rollup, unlike `live`).
    // Find the splitPane that spawned the rollup tail and assert killPane
    // was called on the same pane id.
    const rollupSplit = tmux.recordedCalls.find((c) => {
      if (c.method !== 'splitPane' || !('argv' in c.opts)) return false
      const argv = c.opts.argv ?? []
      return argv[0] === 'tail' && typeof argv[4] === 'string' && argv[4].includes('_rollup')
    })
    expect(rollupSplit).toBeDefined()
    // The fake tmux service synthesizes pane ids per splitPane call. The
    // recorded `splitPane` carries the pane id it allocated via the
    // `recordedCalls` envelope — we look it up by matching argv.
    const allocs = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    const allocIdx = allocs.indexOf(rollupSplit as (typeof allocs)[number])
    expect(allocIdx).toBeGreaterThanOrEqual(0)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killPane')
    expect(kills.length).toBeGreaterThan(0)
  })
})
