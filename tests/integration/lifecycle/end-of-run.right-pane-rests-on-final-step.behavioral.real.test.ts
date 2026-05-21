/**
 * Behavioral cell — at end-of-run the right pane is supposed to rest on the
 * final step's transcript. The on-pane "rest" point is unobservable after
 * orch tears down on successful workflow exit; the durable proof is that
 * the final step has a complete on-disk transcript artifact (the same file
 * the right pane was tailing).
 *
 * If/when orch grows a `--keep-tui-on-complete` mode (or the user has an
 * attached client), this can be promoted to a pane capture cell.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertFilesystem,
  awaitRunStatus,
  awaitVisibleStep,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  runArtifactExists,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — right pane rests on final step', () => {
  it('the final step has a non-empty events.ndjson and session.json on disk', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle
      .agent('plan')
      .emit({ kind: 'info', type: 'thinking', payload: { text: 'planning' } })
    await handle.agent('plan').complete()

    await handle
      .agent('execute')
      .emit({ kind: 'info', type: 'thinking', payload: { text: 'executing' } })
    await handle.agent('execute').complete()

    await handle
      .agent('finalize')
      .emit({ kind: 'info', type: 'thinking', payload: { text: 'finalizing' } })
    await handle.agent('finalize').complete()
    await awaitRunStatus('completed', { timeoutMs: 10_000 })

    // The on-disk transcript is what the right pane was tailing. After the
    // run completes, `finalize`'s events.ndjson + session.json must exist and
    // be non-empty (Batch 1's per-step artifacts cell asserts the same shape
    // mid-run; this cell focuses on the FINAL step at end-of-run).
    await assertFilesystem(
      withinMs(5_000),
      runArtifactExists('session', 'finalize'),
      runArtifactExists('events', 'finalize'),
    )
  }, 45_000)
})
