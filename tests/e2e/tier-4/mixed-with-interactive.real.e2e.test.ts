// triage: keep — Tier 4 starter (R11) for the mixed autonomous + interactive
// flow. Deferred until the harness ships an interactive-step convenience —
// running an interactive Claude step end-to-end requires either a TTY-bound
// child or a captured input stream the harness does not currently expose.
// Skipped at the suite level so the file is wired in, the gating works, and
// follow-up work can swap the placeholder for a real assertion.

import { describe, it } from 'bun:test'

// DROPPED → never executed (it.skip placeholder); interactive-PTY-step harness not built — deferred follow-up (parent U9/W4). Kept skipped on disk (D2).
describe.skip('Tier 4 — mixed autonomous + interactive (DROPPED — needs interactive harness helper)', () => {
  it.skip('autonomous step + interactive step share the same harness body', () => {
    // Implementation deferred — follow-up unblocks once the harness ships
    // an `interactiveStep(prompt, agent)` helper that drives a Claude PTY
    // step through the host's runInteractive path.
  })
})
