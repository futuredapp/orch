/**
 * Behavioral cell — interactive step renders the `⟳` interactive glyph in
 * its row, while autonomous siblings do not.
 *
 * Punted from Batch 1: this cell requires an interactive-and-autonomous
 * fixture and a runner that opens a PTY. ScriptedFakeRunner does NOT
 * support `interactive: true` (its `defineRunner` opts say
 * `supports: { interactive: false }`), so a fixture wired through
 * scripted-fake will fail to construct an interactive step. Tier 5 does not
 * exercise real Claude/Codex (that's Tier 4). Leaving as it.todo with a
 * pointer to the constraint until either (a) a fake PTY-capable runner is
 * added, or (b) this cell is promoted to Tier 4.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

beforeEach(() => {
  /* no setup */
})

afterEach(async () => {
  /* no teardown */
})

// MIGRATED → (dropped) — parent U4.
// drop: a blocked `it.todo` that never executed (scripted-fake has no
// interactive mode). Re-derive when an interactive/PTY-capable fake runner
// exists (parent U9 / recorded-agent). Nothing to port — it asserted nothing.
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — interactive badge rendering', () => {
  it.todo('renders the interactive glyph on an interactive step (blocked: scripted-fake does not support interactive mode; needs Tier 4 or a PTY-capable fake runner)', async () => {
    /* see findings doc D-1 */
  })
})
