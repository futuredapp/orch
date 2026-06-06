/**
 * Tier 5 — `double-sigint-to-orch-during-mid-step.real.test.ts`
 *
 * PREDICTED ON FIRST RUN: PASS — empirically, sending a second SIGINT
 * while orch is still processing the first one's teardown is harmless
 * (the second arrives after the handler has already begun and is
 * effectively a no-op or accelerates the path). The §6.5 `signal-sigint`
 * contract still holds: clean exit (code=130/signal=SIGINT), tmux
 * session torn down, escapes balanced, no orphan children.
 *
 * Distinct from `sigint-to-orch-during-mid-step` (single SIGINT) — this
 * cell asserts the same contract still holds after a second redundant
 * SIGINT, guarding against a future regression where a double signal
 * wedges the handler.
 *
 * If this cell becomes FAIL-BUG (the handler wedges on the second
 * signal), U11 captures the failure as new evidence — the inline comment
 * here serves as the predicted-baseline anchor.
 *
 * Gating: tmux on PATH only. Default CI runs this.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertOrchExits,
  assertTerminalEscapeStream,
  assertTmuxSession,
  exitedNormally,
  holdUntilReleased,
  launchOrchWorkflow,
  noOrphanChildren,
  type OrchHandle,
  signalOrch,
  terminalRestoredCleanly,
  tmuxIsTornDown,
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

// MIGRATED → tests-new/lifecycle/double-sigint--still-reaches-clean-shutdown.test.ts — parent U8 (G1).
// port: a redundant second SIGINT still reaches the clean shutdown state.
describe.skipIf(!canRunRealTmux())('Tier 5 — double SIGINT to orch during mid-step', () => {
  it.skip('still reaches the §6.5 signal-sigint clean state after a redundant SIGINT', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    await userAction(signalOrch('SIGINT'))
    await userAction(signalOrch('SIGINT'))

    await assertOrchExits(withinMs(10_000), exitedNormally())
    await assertTmuxSession(withinMs(5_000), tmuxIsTornDown())
    await assertTerminalEscapeStream(withinMs(5_000), terminalRestoredCleanly(), noOrphanChildren())
  }, 30_000)
})
