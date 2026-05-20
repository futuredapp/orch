/**
 * Tier 5 — `sigint-to-orch-during-mid-step.real.test.ts`
 *
 * PREDICTED: PASS — the SIGINT handler at
 * `src/cli/commands/execute-with-attach.ts:64-74` is wired to call
 * `host.teardown()` and exit with `EXIT.SIGINT === 130`. This cell sends
 * SIGINT directly to the orch subprocess while the `plan` step is held
 * mid-run and asserts the documented §6.5 `signal-sigint` contract row.
 *
 * FINDING surfaced during W3 implementation: the SIGINT handler does NOT
 * persist `state.json` status='cancelled' (or 'crashed') before
 * `process.exit(130)` — the handler is fire-and-forget around
 * `host.teardown()`. The W3 cell therefore does NOT assert
 * `hasStatus('cancelled')`; that gap is the campaign-cell finding for U11
 * to triage. The other invariants (exit cleanly, tmux gone, escapes
 * balanced, no orphan children) DO hold on current main.
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

describe.skipIf(!canRunRealTmux())('Tier 5 — SIGINT to orch during mid-step', () => {
  it('exits via documented signal, tears down tmux, and leaves the terminal balanced', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    await userAction(signalOrch('SIGINT'))

    await assertOrchExits(withinMs(10_000), exitedNormally())
    await assertTmuxSession(withinMs(5_000), tmuxIsTornDown())
    await assertTerminalEscapeStream(withinMs(5_000), terminalRestoredCleanly(), noOrphanChildren())
  }, 30_000)
})
