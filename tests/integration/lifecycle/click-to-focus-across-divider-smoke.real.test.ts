/**
 * Tier 5 — `click-to-focus-across-divider-smoke.real.test.ts`
 *
 * PREDICTED: PASS — appliance-mode (`src/services/tmux/session-init.ts`)
 * installs a server-side click-to-focus binding. This smoke cell asserts
 * that the harness's `clickOnPane` user-action moves focus across the
 * pane divider, exercising both the mouse-event builder (`buildSgrMouse`)
 * and the focus matcher (`isFocused`) in a real round-trip.
 *
 * Gating: only requires tmux on PATH; no real CLI needed.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  assertRightPane,
  clickOnPane,
  holdUntilReleased,
  isFocused,
  launchOrchWorkflow,
  type OrchHandle,
  userAction,
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

describe.skipIf(!canRunRealTmux())('Tier 5 — click-to-focus across the divider', () => {
  it('clicks move focus between the left and right panes', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    // Click on the right pane → it becomes focused.
    await userAction(clickOnPane('right'))
    await assertRightPane(withinMs(5_000), isFocused())

    // Click back on the left pane → focus moves over.
    await userAction(clickOnPane('left'))
    await assertLeftPane(withinMs(5_000), isFocused())
  }, 30_000)
})
