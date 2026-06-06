/**
 * Behavioral cell — an error banner (kind: 'error', no ttlMs) persists
 * until Esc is pressed (or another emit replaces it).
 *
 * BLOCKED at Tier 5: at present the only host path that emits a `kind: 'error'`
 * banner is `step:failed` in tmux-host.ts:740. The `execute-with-attach.ts`
 * error catch calls `host.teardown()` immediately on the same exception,
 * so the tmux session is gone within tens of milliseconds and there is
 * no observable window for the test to capture the banner — see Group E
 * cells (failure.*) for the workaround using lifecycle.ndjson.
 *
 * To unblock this cell at Tier 5 the product would need to either keep
 * the TUI mounted in `--no-attach` mode on workflow failure (so the user
 * sees the error banner before quitting), or expose an emitBanner test
 * seam. Neither is acceptable as a behavior-changing addition under the
 * Tier 5 charter. The behavior IS covered at Tier 1 via in-process host
 * tests against `RightPaneController.emitBanner`.
 *
 * See findings doc entry F-5 (deferred).
 */

import { describe, it } from 'bun:test'

// COVERED BY → tests-new/model/banner--info-clears-error-persists.test.ts — parent U8 (W6 close-out; U5b area).
// drop: a never-executed `it.todo` placeholder (blocked at Tier 5 by the teardown
// race). The persist-past-TTL behaviour is covered at the model seam (U5b); the
// Esc-dismiss half never ran and asserted nothing. File fully `describe.skip`.
describe.skip('Tier 5 behavioral — error banner persists until Escape', () => {
  it.todo('error banner stays visible past the info-TTL and dismisses on Esc (blocked: orch tears down on step:failed; Tier 5 cannot observe post-failure pane state — see findings F-5)', async () => {
    /* see findings doc F-5 */
  })
})
