/**
 * Tier 5 — `sighup-to-orch-during-mid-step.real.test.ts`
 *
 * PREDICTED ON FIRST RUN: PASS — the signal handler at
 * `src/cli/commands/execute-with-attach.ts:64-78` wires SIGHUP to
 * `host.teardown()` and `process.exit(EXIT.SIGHUP === 129)`. SIGHUP is
 * what a real controlling-TTY hangup delivers when the user closes the
 * terminal window — covering the "I closed my terminal" recovery path
 * the user reported in origin §2 S4.
 *
 * Distinct from `close-stdin-during-mid-step` — the latter writes
 * stdin-EOF to a piped child (which does NOT have a controlling TTY),
 * and the orch signal handler only fires on real SIGHUP. Both cells
 * exist; they exercise different code paths.
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

describe.skipIf(!canRunRealTmux())('Tier 5 — SIGHUP to orch during mid-step', () => {
  it('exits cleanly, tears down tmux, and leaves the terminal balanced', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    await userAction(signalOrch('SIGHUP'))

    await assertOrchExits(withinMs(10_000), exitedNormally())
    await assertTmuxSession(withinMs(5_000), tmuxIsTornDown())
    await assertTerminalEscapeStream(withinMs(5_000), terminalRestoredCleanly(), noOrphanChildren())
  }, 30_000)
})
