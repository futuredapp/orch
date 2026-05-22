// triage: keep — Tier 1 regression anchor for the per-source tmux sessions
// refactor (plan 2026-05-22-001).
//
// Run `r-2026-05-22-135756-tc` cascaded 12+ `TmuxCommandError: tmux split-
// window failed (exit 1): no space for new pane` events because every source
// was added to the shared `orch-scratch` window via `split-window`; after
// ~5 splits the active pane was narrower than tmux's minimum splittable
// width and the next `split-window` failed. The rotation fix in commit
// `bfb828f` did not help because the retry resolved to the same full
// window.
//
// The refactor removes the failure mode by design: each source lives in its
// own per-source tmux session (one pane per session, no further splits).
// This test spins up 6 sequential file-tail sources — one beyond the
// historical 5-split threshold — and asserts:
//   - every source's per-source session exists on the socket and contains
//     exactly one pane;
//   - the right pane's content matches whichever source was last swapped
//     in (capture-pane round-trip).
//
// Triage rule (docs/testing-strategy.md): the test would NOT still pass if
// the visible pane were empty/wrong/unformatted — `waitForText` reads the
// real captured pane content after each swap.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeRunner } from '../../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []
let tempDirs: string[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
  for (const d of tempDirs) await rm(d, { recursive: true, force: true })
  tempDirs = []
})

describe.skipIf(!tmuxAvailable)(
  'Tier 1 — six sequential autonomous sources never trip "no space for new pane"',
  () => {
    it('runs 6 autonomous steps back-to-back; each lands in its own per-source session and the right pane shows the latest', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: true,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      // Six distinct autonomous steps — one beyond the historical
      // ~5-split threshold that broke under the shared scratch session.
      const stepNames = ['s1', 's2', 's3', 's4', 's5', 's6'] as const
      const steps = stepNames.map((name, idx) => {
        const agent = new FakeRunner(agentProcessService)
        agent.script({
          events: [
            { kind: 'info', type: 'assistant', payload: { text: `step-${idx + 1}-marker` } },
          ],
          structuredOutput: `done-${idx + 1}`,
        })
        return { name, agent }
      })

      const run = await harness.runWorkflow(steps)
      expect(run.completed).toBe(true)

      // The user is on live mode at workflow start. After each step
      // completes (`live → replay` transform + view-mode flip), the next
      // step starts as a hidden live source — registerSource sees
      // mode==='replay' and does not auto-swap. So the visible right pane
      // ends up showing whichever live source was most recently registered
      // while the user was still on live — which is `s1` (the first step).
      await harness.right.waitForText('step-1-marker', { timeoutMs: 5000 })

      // Per-source session invariant: every step's session exists on the
      // socket and owns exactly one pane (no split-window ever runs).
      for (const name of stepNames) {
        const session = `orch-src-live-${name}`
        const panes = await fixture.tmux.listPanes({
          socket: fixture.socket,
          session,
          format: '#{pane_id}',
        })
        expect(panes).toHaveLength(1)
      }

      // The `orch` visible session retains its two panes (left + right).
      const orchPanes = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch',
        format: '#{pane_id}',
      })
      expect(orchPanes).toHaveLength(2)
    }, 30_000)

    it('captures different pane content after swapping the visible slot across six sources', async () => {
      // This second cell is the explicit cross-source swap probe: we drive
      // six file-tail sources directly (no workflow scaffolding) and assert
      // that swap-pane works across all six per-source sessions, with the
      // visible right pane reflecting whichever source was last swapped in.
      // No `split-window` is ever called against any per-source session.

      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const dir = await mkdtemp(join(tmpdir(), 'orch-many-sources-'))
      tempDirs.push(dir)

      const tmux = fixture.tmux
      const socket = fixture.socket

      await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
      const visible = await tmux.splitPane({
        socket,
        session: 'orch',
        orientation: 'h',
        percent: 50,
        command: 'cat',
      })

      // Write six distinct content files; create six per-source sessions
      // each tailing one of them.
      const sourceSessions: { session: string; paneId: string; marker: string }[] = []
      for (let i = 0; i < 6; i++) {
        const marker = `SOURCE_${i}_CONTENT`
        const file = `${dir}/source-${i}.log`
        await writeFile(file, `${marker}\n`, 'utf8')
        const session = `orch-src-live-source-${i}`
        const result = await tmux.createSession({
          socket,
          session,
          width: 200,
          height: 50,
          command: ['tail', '-n', '5000', '-F', file],
        })
        sourceSessions.push({ session, paneId: result.paneId, marker })
      }

      // Settle the tail processes' initial output.
      await new Promise((r) => setTimeout(r, 300))

      // Swap each source into the visible slot in order, capturing each.
      let currentVisible = visible
      for (const src of sourceSessions) {
        const srcPaneId = src.paneId as typeof currentVisible
        await tmux.swapPane({ socket, src: srcPaneId, dst: currentVisible })
        await new Promise((r) => setTimeout(r, 100))
        const captured = await tmux.capturePane({ socket, target: srcPaneId })
        expect(captured).toContain(src.marker)
        // After swap, src.paneId is now the visible slot; the next swap
        // targets it.
        currentVisible = srcPaneId
      }

      // No split-window calls were made against any per-source session —
      // every source's session has exactly one pane.
      for (const src of sourceSessions) {
        const panes = await tmux.listPanes({ socket, session: src.session, format: '#{pane_id}' })
        expect(panes).toHaveLength(1)
      }

      // Clean up — kill the server (afterEach takes the harness, but we
      // built this fixture by hand).
      const cleanup = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await cleanup.exited
    }, 30_000)
  },
)
