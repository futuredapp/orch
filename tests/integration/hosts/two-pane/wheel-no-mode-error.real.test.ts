// triage: keep — smart-wheel regression guard for the strict-sandbox amendment.
//
// The original `not in a mode` regression (origin docs/brainstorms/
// 2026-05-05-tmux-strict-sandbox-brainstorm.md) fired because tmux's default
// wheel-up-in-alt-screen binding tried to enter copy-mode, found the pane
// already in an alternate-screen mode, and leaked the literal string
// `not in a mode` into the visible pane. The amendment retires this regression
// class structurally via `if-shell -F #{?mouse_any_flag,1,0}` + `alternate_on`:
// copy-mode is ONLY reachable when the pane is not on the alt-screen AND no
// mouse capture is asserted. This test pins the structural shape so a future
// edit cannot lose either guard without breaking the assertion.
//
// Wheel-event injection from outside the terminal emulator is not faithfully
// reproducible via `tmux send-keys` (verified empirically against tmux 3.6a in
// U2 characterization); for true end-to-end wheel coverage, see the manual
// reproduction note in `docs/getting-started.md` under "Appliance mode".

import { afterEach, describe, expect, it } from 'bun:test'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

describe.skipIf(!tmuxAvailable)(
  'Tier 1 — smart-wheel binding structurally prevents the `not in a mode` regression',
  () => {
    it('list-keys -T root after init exposes WheelUpPane and WheelDownPane with the nested if-shell shape gating copy-mode entry on both mouse_any_flag and alternate_on', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const proc = Bun.spawn(['tmux', '-L', fixture.socket, 'list-keys', '-T', 'root'], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      const wheelLines = stdout
        .split('\n')
        .filter((l) => l.includes('WheelUpPane') || l.includes('WheelDownPane'))

      // Both wheel events must be present.
      expect(wheelLines.some((l) => l.includes('WheelUpPane'))).toBe(true)
      expect(wheelLines.some((l) => l.includes('WheelDownPane'))).toBe(true)

      // Both must encode the dual-guard rule: mouse_any_flag at the outer
      // conditional, alternate_on at the inner one. Losing either guard
      // re-opens the `not in a mode` regression class.
      for (const line of wheelLines) {
        expect(line).toContain('mouse_any_flag')
        expect(line).toContain('alternate_on')
        expect(line).toContain('send-keys -M')
        expect(line).toContain('copy-mode -e')
      }
    })

    it('copy-mode and copy-mode-vi tables are empty after init so a stale entry from the wheel rule cannot leak `not in a mode`', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
        const proc = Bun.spawn(['tmux', '-L', fixture.socket, 'list-keys', '-T', table], {
          stdout: 'pipe',
          stderr: 'ignore',
        })
        const stdout = await new Response(proc.stdout).text()
        await proc.exited
        expect(stdout.trim()).toBe('')
      }
    })

    it('the if-shell format strings evaluate against tmux 3.3+ without errors when probed via display-message', async () => {
      // Pins that #{?mouse_any_flag,1,0} and #{?alternate_on,1,0} are valid
      // format strings on the running tmux version — bumping the tmux floor
      // to 3.3 (where mouse_any_flag was introduced) is what makes the
      // outer conditional well-formed.
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      for (const format of ['#{?mouse_any_flag,1,0}', '#{?alternate_on,1,0}']) {
        const proc = Bun.spawn(['tmux', '-L', fixture.socket, 'display-message', '-p', format], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        expect(exitCode).toBe(0)
        // Both flags should evaluate to either '0' or '1' (boolean format).
        expect(['0', '1']).toContain(stdout.trim())
      }
    })
  },
)
