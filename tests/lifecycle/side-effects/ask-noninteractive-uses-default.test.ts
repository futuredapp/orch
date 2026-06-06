/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/ask.noninteractive-uses-default-and-does-not-block.behavioral.real.test.ts`.
 *
 * Side effect / non-blocking behaviour: `ask(...)` with
 * `defaultWhenNoninteractive` resolves non-interactively when orch is launched
 * with `--noninteractive` — the run does not block on the ask, and the following
 * step runs to completion. Relocation parity: same assertions, new path.
 */

import { describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
  hasStepCompleted,
  puppet,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — ask resolves its default in noninteractive', () => {
  it('--noninteractive resolves the ask to its declared default and the next step runs', async () => {
    const handle = await withOrchHandle('ask-with-default', {
      script: { after: puppet() },
      cliArgs: ['--noninteractive'],
    })

    // The ask step resolves itself; we then drive `after` to complete.
    await awaitStepStatus('ask:continue', 'completed', { timeoutMs: 15_000 })

    await handle.agent('after').complete()
    await awaitStepStatus('after', 'completed', { timeoutMs: 10_000 })
    await awaitRunStatus('completed', { timeoutMs: 10_000 })

    await assertPersistedState(
      withinMs(5_000),
      hasStepCompleted('ask:continue'),
      hasStepCompleted('after'),
    )
  }, 30_000)
})
