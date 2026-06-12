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
} from '@orch/test/real-tmux/index.ts'

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
    it('list-keys -T root after init exposes WheelUpPane with the nested if-shell shape gating copy-mode entry on both mouse_any_flag and alternate_on', async () => {
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

      const upLine = stdout.split('\n').find((l) => l.includes('WheelUpPane'))
      expect(upLine).toBeDefined()
      if (upLine === undefined) throw new Error('expected WheelUpPane in list-keys -T root')

      // WheelUpPane must encode the dual-guard rule: mouse_any_flag at the
      // outer conditional, alternate_on at the inner one. Losing either guard
      // re-opens the `not in a mode` regression class.
      expect(upLine).toContain('mouse_any_flag')
      expect(upLine).toContain('alternate_on')
      expect(upLine).toContain('send-keys -M')
      expect(upLine).toContain('copy-mode -e')
    })

    it('WheelDownPane in the root table NEVER falls back to copy-mode at the live tail — only WheelUp opens scrollback (regression guard for trapped-in-copy-mode)', async () => {
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

      const downLine = stdout.split('\n').find((l) => l.includes('WheelDownPane'))
      expect(downLine).toBeDefined()
      if (downLine === undefined) throw new Error('expected WheelDownPane in list-keys -T root')

      // WheelDownPane keeps the same outer mouse_any_flag / inner alternate_on
      // forwards for apps that opt into mouse tracking or alt-screen — but
      // the live-tail else branch is GONE: scrolling down on a normal text
      // pane is a no-op, not a copy-mode trap.
      expect(downLine).toContain('mouse_any_flag')
      expect(downLine).toContain('alternate_on')
      expect(downLine).toContain('send-keys -M')
      expect(downLine).not.toContain('copy-mode')
    })

    it('copy-mode and copy-mode-vi tables contain ONLY the audited allowlist after init — exit (q/Escape/C-c), scroll (j/k/Up/Down/PageUp/PageDown/g/G/wheel), and the V3 drag-end yank — so the user can never get trapped', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      // The exact keys we expect in BOTH copy-mode tables. Extra defaults
      // surviving the wipe would re-introduce send-keys -X callsites the
      // strict-sandbox plan explicitly removes. tmux normalizes the input
      // keys on display: `PageUp` is shown as `PPage`, `PageDown` as `NPage`.
      const expectedKeys = new Set([
        'q',
        'Escape',
        'C-c',
        'j',
        'k',
        'Down',
        'Up',
        'NPage',
        'PPage',
        'g',
        'G',
        'WheelUpPane',
        'WheelDownPane',
        // V3 steps-pane copy: the drag-end yank routes through the copy-mode
        // table because MouseDrag1Pane already entered copy-mode via
        // `copy-mode -M`. It is part of the audited allowlist, not a leak.
        'MouseDragEnd1Pane',
      ])

      for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
        const proc = Bun.spawn(['tmux', '-L', fixture.socket, 'list-keys', '-T', table], {
          stdout: 'pipe',
          stderr: 'ignore',
        })
        const stdout = await new Response(proc.stdout).text()
        await proc.exited

        const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
        // Every bound key in this table must be in the allowlist; the wipe
        // happened before the install, so anything extra is a regression.
        for (const line of lines) {
          const found = [...expectedKeys].some((k) => line.includes(` ${k} `) || line.endsWith(k))
          if (!found) {
            // Surface the offending line so a regression report points at it.
            throw new Error(`unexpected ${table} binding survived the wipe: ${line}`)
          }
        }

        // Load-bearing escape keys must be present — the bug this test
        // guards against was: copy-mode entered, no `q`/Escape bound, user
        // stuck. Assert by listing each key individually.
        for (const must of ['q', 'Escape', 'C-c']) {
          expect(lines.some((l) => l.includes(must))).toBe(true)
        }
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
