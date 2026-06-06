// Shared lifecycle-handle plumbing for the side-effect / persistence tests.
//
// These tests drive a real `orch` subprocess (the behavioral-dsl engine) and
// assert git / filesystem / persisted-state SIDE EFFECTS — zero pane assertions.
// They run at a single fidelity and have no multi-driver twin, so they are plain
// `it()` tests, NOT `scenario()` (see README.md). The behavioral-dsl helpers key
// off a process-global current handle, so lifecycle runs serially
// (`--max-concurrency=1`); a single shared `afterEach` tears the handle down.

import { afterEach } from 'bun:test'
import { launchOrchWorkflow, type OrchHandle } from '@orch/test/behavioral-dsl/index.ts'
import { canRunRealTmux } from '@orch/test/real-tmux/index.ts'

/** Gate the whole category on real tmux (capability, not migration `.skip`). */
export const tmuxAvailable = canRunRealTmux()

let current: OrchHandle | undefined

afterEach(async () => {
  if (current !== undefined) await current.teardown()
  current = undefined
})

/**
 * Launch an orch workflow and register it for teardown after the test — the
 * shared replacement for each old file's per-file `beforeEach`/`afterEach`
 * handle plumbing. Same arguments as `launchOrchWorkflow`.
 */
export async function withOrchHandle(
  ...args: Parameters<typeof launchOrchWorkflow>
): Promise<OrchHandle> {
  const handle = await launchOrchWorkflow(...args)
  current = handle
  return handle
}
