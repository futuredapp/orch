/**
 * Behavioral cell — workflow launch initial UI render.
 *
 * Probes that after `launchOrchWorkflow`, the left pane shows:
 *   - the workflow name in the header
 *   - the configured step row(s)
 *   - the live-mode footer hints (`↑↓ select · ⏎ view · f follow · ? help · q quit`)
 *
 * Driven by `puppet()` so the first step stays running (and visible) without
 * needing a gate-file round-trip. The puppet receives no commands in this
 * cell — orch is torn down by `afterEach` without ever completing the step.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitVisibleStep,
  containsText,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  showsStep,
  showsWorkflowHeader,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — workflow launch render', () => {
  it('renders workflow name, step row, and live-mode footer in the left pane', async () => {
    handle = await launchOrchWorkflow('single-agent-step', {
      script: { work: puppet() },
    })

    await awaitVisibleStep('left', 'work', { timeoutMs: 10_000 })

    // Note: a single-step workflow renders an abbreviated footer
    // (`▶ live · ⏎ view step · q quit · ? help`) — the `↑↓ select` / `f follow`
    // hints only appear when the steps list has > 1 entry. See the
    // `three-step-linear` fixture for the multi-step variant.
    await assertLeftPane(
      withinMs(10_000),
      showsWorkflowHeader('behavioral-single-agent-step'),
      showsStep('work'),
      containsText('▶ live'),
      containsText('view'),
      containsText('quit'),
    )
  }, 30_000)
})
