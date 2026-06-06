/**
 * Tier 5 — `sigterm-to-orch-during-mid-step.real.test.ts`
 *
 * PREDICTED ON FIRST RUN: PASS — the signal handler at
 * `src/cli/commands/execute-with-attach.ts:64-78` wires SIGTERM to
 * `host.teardown()` and `process.exit(EXIT.SIGTERM === 143)`. This cell
 * sends SIGTERM directly to the orch subprocess while `plan` is held
 * mid-run and asserts the §6.5 `signal-sigterm` contract: clean exit,
 * tmux session torn down, escapes balanced, no orphan children.
 *
 * If this cell turns into a FAIL-BUG (orch fails to tear down on
 * SIGTERM), U11 captures the failure as a separate bug from the §2.1
 * `q`-during-mid-step bug.
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

// MIGRATED → tests-new/lifecycle/sigterm--exits-cleanly-and-tears-down.test.ts — parent U8 (G1).
// port: SIGTERM shutdown invariants (exit/tmux-down/terminal-balanced/no-orphans).
describe.skipIf(!canRunRealTmux())('Tier 5 — SIGTERM to orch during mid-step', () => {
  it.skip('exits cleanly, tears down tmux, and leaves the terminal balanced', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    await userAction(signalOrch('SIGTERM'))

    await assertOrchExits(withinMs(10_000), exitedNormally())
    await assertTmuxSession(withinMs(5_000), tmuxIsTornDown())
    await assertTerminalEscapeStream(withinMs(5_000), terminalRestoredCleanly(), noOrphanChildren())
  }, 30_000)
})
