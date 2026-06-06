/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/failure.right-pane-shows-failure-summary.behavioral.real.test.ts`.
 *
 * Despite its old NAME, this cell asserts a durable on-disk side effect, not
 * pane content: when a step fails, the host writes a failure summary payload
 * (`step "<name>" failed: <error>`) into the per-step tee file — the on-disk
 * equivalent of the right-pane failure block — which survives the teardown that
 * immediately follows. Relocation parity: same assertions, new path.
 */

import { describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  fileContains,
  puppet,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)(
  'side-effects — failure summary is captured to the tee file',
  () => {
    it('the per-step tee file contains the failure headline and error text', async () => {
      const handle = await withOrchHandle('puppet-can-fail', {
        script: { plan: puppet(), execute: puppet() },
      })

      await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
      await handle.agent('plan').complete()
      await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

      await awaitVisibleStep('left', 'execute', { timeoutMs: 10_000 })
      await handle.agent('execute').fail({ message: 'boom-d17-summary' })
      await awaitRunStatus('failed', { timeoutMs: 10_000 })

      // Per-step tee path: `<logsDir>/agents/<step>/formatted_output.ansi`. The
      // two-pane host writes the failure-pane payload here on step:failed so the
      // failure block survives the host teardown that immediately follows.
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
  },
)
