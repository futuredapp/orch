/**
 * Tier 5 — `close-stdin-during-mid-step.real.test.ts`
 *
 * PREDICTED ON FIRST RUN: unknown — orch v1 has no handler for stdin-EOF
 * on a piped stdin. The §6.5 `close-stdin` contract row is intentionally
 * weak (only `terminalRestoredCleanly()`), documenting observed behavior
 * rather than asserting full teardown. This cell exercises the stdin-EOF
 * path and lets the outcome — orch keeps running (weakly OK) or orch
 * crashes/exits (stronger evidence) — drive the U11 findings entry.
 *
 * Distinct from `sighup-to-orch-during-mid-step` — closing a piped stdin
 * does NOT deliver SIGHUP; the controlling-TTY hangup path is covered by
 * that other cell.
 *
 * Gating: tmux on PATH only. Default CI runs this.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertTerminalEscapeStream,
  closeOrchStdin,
  holdUntilReleased,
  launchOrchWorkflow,
  type OrchHandle,
  terminalRestoredCleanly,
  userAction,
  wait,
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

describe.skipIf(!canRunRealTmux())('Tier 5 — stdin-EOF to orch during mid-step', () => {
  it('preserves the weak close-stdin contract — terminal stays balanced', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    await userAction(closeOrchStdin())

    // No teardown matcher — the contract documents observed behavior.
    // Give orch a settling window before asserting the weak invariant.
    await userAction(wait(2_000))
    await assertTerminalEscapeStream(withinMs(5_000), terminalRestoredCleanly())
  }, 30_000)
})
