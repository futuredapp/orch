// Real-tmux behavioral test: the left-pane steps-view must show its
// `orch · <workflow> · <runId>` breadcrumb exactly once even after many
// state changes and pane resizes.
//
// Bug observed in production: the breadcrumb stacks vertically — each
// state change or resize leaves a stale `orch · <…> · <…>` line above
// the live frame. Eight or more copies eventually pile up at the top of
// the left pane (see screenshot in the bug report).
//
// Triage rule (docs/testing-strategy.md): "would this test still pass if
// the visible pane were wrong / unformatted?" — no. We capture the
// rendered pane content via `tmux capture-pane` and count occurrences of
// the breadcrumb. Anything > 1 fails the test.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
} from '@orch/test/real-tmux/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

async function resizeLeftPaneWidth(
  fixture: RealTmuxFixture,
  leftPaneIdValue: string,
  width: number,
): Promise<void> {
  const proc = Bun.spawn(
    ['tmux', '-L', fixture.socket, 'resize-pane', '-t', leftPaneIdValue, '-x', String(width)],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  await proc.exited
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

describe.skipIf(!tmuxAvailable)(
  'left-pane steps-view header does not duplicate on state changes + resizes',
  () => {
    it(
      'renders the run breadcrumb exactly once after several state changes and pane resizes',
      async () => {
        const fixture = await createRealTmuxFixture({ env: {}, width: 200, height: 50 })
        fixturesToDispose.push(fixture)

        const fps = new FakeProcessService()
        const harness = await mountTmuxHost(fixture, {
          workflowName: 'tic-tac-toe',
          disableStepsView: false,
          agentProcessService: fps,
        })
        harnessesToTeardown.push(harness)

        // Resolve the left pane id (the steps-view daemon was respawned onto it
        // by `createTmuxHost`). The harness's `left.paneId` returns a promise.
        const leftPaneId = await harness.left.paneId

        // Drag the pane border: cycle through narrow ↔ wide widths so the Ink
        // child sees several SIGWINCH events with wrapping ↔ non-wrapping
        // breadcrumb layouts. Each call returns once tmux has applied the new
        // pane geometry; the kernel then propagates SIGWINCH to the Ink child.
        const drag = async (widths: readonly number[]): Promise<void> => {
          for (const w of widths) {
            await resizeLeftPaneWidth(fixture, leftPaneId, w)
            // Pacing between SIGWINCH deliveries, not an assertion
            // synchronization: a slow machine just coalesces resizes, so this
            // is intentionally a plain fixed sleep and not a poll.
            await sleep(120)
          }
        }

        // Initial render: wait for the Ink child's first frame (the
        // breadcrumb) instead of sleeping a fixed duration.
        await harness.left.waitFor((pane) => pane.includes('orch · tic-tac-toe · '), {
          timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
        })

        // Set up FakeRunner scripts for a multi-step workflow. Each step's
        // start/complete cycle writes a lifecycle event, which the steps-view
        // tail picks up and reprojects → Ink rerenders.
        const STEP_COUNT = 6
        const agent = new FakeRunner(fps)
        // Each workflow step calls `buildCommand` multiple times (one for the
        // visible run, one for the logging side-channel). Over-scripting is
        // harmless — unused scripts stay queued.
        for (let i = 0; i < STEP_COUNT * 4; i++) {
          agent.script({ events: [], structuredOutput: { i } })
        }

        // First drag — narrow widths so the breadcrumb wraps.
        await drag([30, 35, 30, 28, 32])

        // Run the workflow. State changes during the run will trigger
        // re-renders at the current narrow width.
        const steps = Array.from({ length: STEP_COUNT }, (_, i) => ({
          name: `step-${i + 1}`,
          agent,
        }))
        const result = await harness.runWorkflow(steps)
        expect(result.completed).toBe(true)

        // Drag again — wider widths so the breadcrumb no longer wraps. Any
        // stale wrapped breadcrumb left over from the narrow renders would
        // become visible above the wider frame.
        await drag([70, 50, 80, 60, 90])

        // Poll until the breadcrumb count settles to exactly one. The final
        // wide-width SIGWINCH triggers an Ink repaint; under full-suite CPU
        // contention that repaint can lag, briefly leaving a stale wrapped
        // breadcrumb visible above the new frame. Polling distinguishes the two
        // failure modes cleanly: transient repaint lag settles to 1 within the
        // budget, while the regression (permanent stacking, 8+ copies) never
        // settles and this assertion times out with the offending frame.
        await harness.left.waitFor(
          (pane) => countOccurrences(pane, 'orch · tic-tac-toe · ') === 1,
          {
            timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
          },
        )
      },
      REAL_TMUX_TEST_TIMEOUT_MS,
    )
  },
)
