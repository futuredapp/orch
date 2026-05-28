/**
 * Behavioral cell — from a viewing state on a completed step, pressing `f`
 * returns the footer to live mode (right pane swaps back to the live step).
 *
 * Previously `it.todo` pending the product fix for findings P-1: `followLive()`
 * swapped the right pane but did not call `setViewMode({ mode: 'live' })`, so
 * the footer stayed stuck on `⏸ viewing <step>`. That is now fixed in
 * `src/hosts/two-pane/pane-map/right-pane-controller.ts` and this cell asserts
 * the footer flips back to live.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitStepStatus,
  awaitVisibleStep,
  containsText,
  doesNotContain,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  showsInkState,
  snapToLive,
  userAction,
  viewStep,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — f snaps to live', () => {
  it('pressing f after entering a viewing state returns the footer to live mode', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    // Complete `plan` so `execute` becomes the live (running) step.
    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle.agent('plan').complete()
    await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

    // Precondition: Enter on the completed plan row flips the footer to
    // viewing mode.
    await userAction(viewStep('plan'))
    await assertLeftPane(withinMs(15_000), containsText('viewing plan'))

    // Pressing `f` snaps back to live: footer leaves viewing mode and the
    // live indicator returns. Budgets are generous (15s) because this cell
    // drives two intent round-trips (Enter then `f`) and the full Tier 5
    // suite runs many real-tmux fixtures concurrently — a loaded box has been
    // observed pushing a single round-trip past the 10s budget the
    // single-round-trip sibling cells use.
    await userAction(snapToLive())
    await assertLeftPane(withinMs(15_000), showsInkState('live'))
    await assertLeftPane(withinMs(15_000), doesNotContain('viewing plan'))
  }, 45_000)
})
