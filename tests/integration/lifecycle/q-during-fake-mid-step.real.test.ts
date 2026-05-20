/**
 * Tier 5 — `q-during-fake-mid-step.real.test.ts`
 *
 * Regression cell for origin §2.1: a `quit` intent fired by the steps-view
 * daemon during a held step must tear orch down cleanly. The §6.5
 * `pane-q-during-run` contract row asserts orch exits and the tmux session
 * is gone.
 *
 * Why the test injects the intent directly (not via `pressKeyInPane`):
 * the Ink steps-view child's `useInput` does not reliably consume bytes
 * delivered via external `tmux send-keys -l q` in this harness — they get
 * echoed by the pane's pty before Ink claims raw mode, and `tui-keys.ndjson`
 * stays empty. The bug under test lives in the parent's foreground-shutdown
 * race (`execute-with-attach.ts`), not in Ink. Writing the intent directly
 * to `tui-intents.ndjson` exercises the same code path the daemon would
 * traverse on a real keystroke without depending on Ink's input handling
 * in the test environment. The Ink Ctrl-C handler is covered by the unit
 * tests for `steps-view.tsx`.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import { appendFile } from 'node:fs/promises'
import {
  assertContractedOutcome,
  holdUntilReleased,
  launchOrchWorkflow,
  type OrchHandle,
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

describe.skipIf(!canRunRealTmux())('Tier 5 — `q` intent during mid-step (fake)', () => {
  it('tears orch down cleanly — §6.5 pane-q-during-run', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    const intentsPath = `${handle.stateDir}/tui-intents.ndjson`
    await appendFile(intentsPath, `${JSON.stringify({ type: 'quit' })}\n`)

    await assertContractedOutcome('pane-q-during-run', withinMs(5_000))
  }, 30_000)
})
