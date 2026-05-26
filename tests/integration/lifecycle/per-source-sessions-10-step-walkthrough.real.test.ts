// Tier 5 lifecycle cell — 10-step workflow walkthrough.
//
// Pins the lifecycle invariants of the per-source tmux sessions refactor
// (plan 2026-05-22-001):
//   - exactly one `source-session-created` per registered live source;
//   - zero `pane-spawn-failed` events;
//   - zero `scratch-window-rotate` events (the type no longer exists);
//   - on teardown, every `source-session-created` has a paired
//     `source-session-torndown`;
//   - the tmux server is gone after host teardown.
//
// The cell uses the same Tier 1 harness as other in-process real-tmux cells
// (`mountTmuxHost`) because it needs to read the lifecycle.ndjson the
// FileSessionLogger writes. Behavioral-dsl cells run orch as a subprocess
// and require fixture files; this cell is in-process and only needs the
// emitted events.

import { afterEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

interface LifecycleEvent {
  readonly type?: string
  readonly sourceKey?: string
  readonly session?: string
}

const readLifecycleEvents = async (logsDir: string): Promise<LifecycleEvent[]> => {
  const text = await readFile(`${logsDir}/lifecycle.ndjson`, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

// The host's lifecycle side effects (source-session creation, register) are
// serialized behind the choreographer's FIFO queue, so they trail the fast
// FakeRunner workflow's completion instead of finishing synchronously with it.
// Poll the lifecycle log until the predicate holds rather than reading once.
const waitForLifecycle = async (
  logsDir: string,
  done: (events: LifecycleEvent[]) => boolean,
  timeoutMs = 10_000,
): Promise<LifecycleEvent[]> => {
  const deadline = Date.now() + timeoutMs
  let events: LifecycleEvent[] = []
  while (Date.now() < deadline) {
    events = await readLifecycleEvents(logsDir)
    if (done(events)) return events
    await new Promise((r) => setTimeout(r, 25))
  }
  return events
}

const liveCreateCount = (events: LifecycleEvent[]): number =>
  events.filter(
    (e) => e.type === 'source-session-created' && e.sourceKey?.startsWith('live:') === true,
  ).length

describe.skipIf(!tmuxAvailable)(
  'Tier 5 — per-source sessions: 10-step walkthrough lifecycle invariants',
  () => {
    it('runs 10 autonomous steps; no pane-spawn-failed or scratch-window-rotate events fire; teardown reaps every per-source session', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: true,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const steps = Array.from({ length: 10 }, (_, idx) => {
        const agent = new FakeRunner(agentProcessService)
        agent.script({
          events: [
            { kind: 'info', type: 'assistant', payload: { text: `step-${idx + 1}-marker` } },
          ],
          structuredOutput: `done-${idx + 1}`,
        })
        return { name: `s${idx + 1}`, agent }
      })

      const run = await harness.runWorkflow(steps)
      expect(run.completed).toBe(true)

      // Verify the workflow really painted the first step on the right pane —
      // protects this assertion suite from "the workflow no-op'd and we
      // counted 10 empty events" failures.
      await harness.right.waitForText('step-1-marker', { timeoutMs: 5000 })

      // Read the lifecycle log MID-RUN — before teardown — so we can
      // distinguish create-time events from teardown-time events. The
      // choreographer's FIFO queue drains the per-source creations after the
      // workflow returns, so poll until all 10 live sources have spawned.
      const logsDir = `${harness.logger.logsDir}`
      const eventsBeforeTeardown = await waitForLifecycle(
        logsDir,
        (events) => liveCreateCount(events) >= 10,
      )

      // Every step's live source spawns exactly once.
      const liveCreates = eventsBeforeTeardown.filter(
        (e) => e.type === 'source-session-created' && e.sourceKey?.startsWith('live:') === true,
      )
      expect(liveCreates).toHaveLength(10)

      // No `pane-spawn-failed` event ever fires. (The refactor's whole point
      // is that the historical "no space for new pane" failure mode can no
      // longer trigger on a 10-step workflow.)
      const failures = eventsBeforeTeardown.filter((e) => e.type === 'pane-spawn-failed')
      expect(failures).toHaveLength(0)

      // The deleted event type must not appear anywhere.
      const rotations = eventsBeforeTeardown.filter((e) => e.type === 'scratch-window-rotate')
      expect(rotations).toHaveLength(0)

      // Same per `pane-spawned` — one per live source.
      const paneSpawned = eventsBeforeTeardown.filter(
        (e) => e.type === 'pane-spawned' && e.sourceKey?.startsWith('live:') === true,
      )
      expect(paneSpawned).toHaveLength(10)

      // Now tear down and re-read.
      await harness.teardown()
      // Drop from the cleanup list so afterEach does not double-teardown.
      harnessesToTeardown = harnessesToTeardown.filter((h) => h !== harness)

      const eventsAfterTeardown = await readLifecycleEvents(logsDir)

      // Each per-source session that was created (live sources rekey to
      // replay during step:complete; their session names stay live:* on
      // disk, so we match by session prefix instead of sourceKey). Count
      // unique session names that were created — they all must be torn
      // down exactly once.
      const createdSessions = new Set(
        eventsAfterTeardown
          .filter((e) => e.type === 'source-session-created')
          .map((e) => e.session)
          .filter((s): s is string => typeof s === 'string'),
      )
      expect(createdSessions.size).toBeGreaterThanOrEqual(10)

      const torndownSessions = new Set(
        eventsAfterTeardown
          .filter((e) => e.type === 'source-session-torndown')
          .map((e) => e.session)
          .filter((s): s is string => typeof s === 'string'),
      )
      for (const session of createdSessions) {
        expect(torndownSessions).toContain(session)
      }

      // The tmux server is gone after host teardown.
      const serverReachable = await fixture.tmux.hasServer({ socket: fixture.socket })
      expect(serverReachable).toBe(false)
    }, 60_000)
  },
)
