// triage: keep — Tier 1 left-pane end-of-run summary visibility.
//
// When the workflow ends, `stateStore.setStatus(runId, 'completed', …)`
// writes the terminal state and the steps-view daemon projects that
// into `<EndOfRunSummary>` + `<EndOfRunFooter>`. The user's exit cue
// — "run completed · q to quit · ⏎ to inspect" plus
// "steps 1/1 completed" — lives only on the left pane. The Tier 2
// `end-of-run-footer.test.tsx` pins the React projection, but the
// real steps-view-runner → tmux capture path is uncovered until now.
// A regression in the daemon's state-watch poll, the projector's
// status branch, or the writer that feeds the left pane would leave
// a finished run looking still-live.

import { afterEach, describe, expect, it } from 'bun:test'
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

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

// MIGRATED → tests-new/screen/end-of-run--summary-and-count-bytes.test.ts  (parent U5b)
describe.skipIf(!tmuxAvailable)(
  'Tier 1 — left pane shows the end-of-run summary after a successful workflow',
  () => {
    it.skip('left.capture() contains `run completed` footer and `steps 1/1 completed` summary', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: false,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const agent = new FakeRunner(agentProcessService)
      agent.script({
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'work complete' } }],
        structuredOutput: 'ok',
      })

      const run = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(run.completed).toBe(true)

      // The daemon polls the state file; give it a generous window so a
      // slow filesystem watcher doesn't flake the assertion. Widened from
      // 5s after CI flakes where state-watch poll + Ink frame emit + tmux
      // render stacked past the original budget.
      await harness.left.waitForText('run completed', { timeoutMs: 10_000 })
      const frame = await harness.left.capture()
      expect(frame).toContain('run completed')
      expect(frame).toContain('steps 1/1 completed')
    }, 20_000)
  },
)
