/**
 * Behavioral cell — when a step fails, the host writes a failure summary
 * payload (`step "<name>" failed: <error>`) into the per-step tee file. This
 * is the on-disk equivalent of the right-pane failure block; it survives
 * teardown so the test can assert against it without racing tmux exit.
 *
 * The on-pane equivalent is covered by Tier 1 (Tier 1 right-pane visibility
 * suite renders the same payload in-process via FailureView). At Tier 5 the
 * pane is torn down by execute-with-attach.ts:174 the moment the workflow
 * throws, so we assert the durable tee file instead.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  fileContains,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

// MIGRATED → tests-new/lifecycle/side-effects/failure-summary-written-to-tee.test.ts — parent U8 (G4).
// port: this cell asserts a DISK side effect (the per-step tee file), not pane
// content — a persistence test (triage = passes if pane empty). The visible
// right-pane failure summary is a rendering concern covered elsewhere (KD3).
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — failure summary is captured', () => {
  it.skip('the per-step tee file contains the failure headline and error text', async () => {
    handle = await launchOrchWorkflow('puppet-can-fail', {
      script: { plan: puppet(), execute: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle.agent('plan').complete()
    await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

    await awaitVisibleStep('left', 'execute', { timeoutMs: 10_000 })
    await handle.agent('execute').fail({ message: 'boom-d17-summary' })
    await awaitRunStatus('failed', { timeoutMs: 10_000 })

    // Per-step tee path: `<logsDir>/agents/<step>/formatted_output.ansi`
    // (src/hosts/plain/per-step-tee.ts:35). The two-pane host writes the
    // failure-pane payload to this same tee on step:failed
    // (src/hosts/two-pane/tmux-host.ts:725) so the failure block survives the
    // host teardown that immediately follows.
    const teeFile = nodePath.join(
      handle.stateDir,
      'logs',
      'agents',
      'execute',
      'formatted_output.ansi',
    )
    await assertFilesystem(
      withinMs(10_000),
      fileContains(teeFile, 'failed'),
      fileContains(teeFile, 'boom-d17-summary'),
    )
  }, 45_000)
})
