// Strict-sandbox ordering test (PR A — tmux strict appliance mode).
//
// Pins the exact call sequence asserted by the plan §"Required call ordering":
//
//   1. fs.writeFile(configPath, …)
//   2. tmux.createSession with configPath
//   3. tmux.unbindKey × 4 (root → prefix → copy-mode → copy-mode-vi)
//   4. tmux.bindKey × 4 (the four-item allowlist)
//   5. tmux.setOption status-right (the discoverability hint)
//   6. tmux.setHook pane-died
//
// Rule 3 (testing-strategy): mocks live at *Service ports only. We use the
// FakeFsService and FakeTmuxService fakes, never `mock.module` on internals.

import { describe, expect, it } from 'bun:test'
import { FakeFsService } from '../../../../src/services/fs/index.ts'
import {
  FakeTmuxService,
  initOrchSession,
  socketName,
} from '../../../../src/services/tmux/index.ts'

const baseOpts = {
  socket: socketName('orch-1'),
  session: 'main',
  width: 200,
  height: 50,
  paneDiedCommand: 'run-shell "tmux -L orch-1 wait-for -S pane-exit-#{hook_pane}"',
}

describe('initOrchSession writes the strict-sandbox tmux config', () => {
  it('writes a config file containing history-limit >= 50000, mouse on, set-clipboard on, allow-passthrough on, mode-style, remain-on-exit on, prefix None, exit-empty off, and destroy-unattached off', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const createCall = tmux.recordedCalls.find((c) => c.method === 'createSession')
    if (createCall?.method !== 'createSession') throw new Error('expected createSession call')
    const configPath = createCall.opts.configPath
    expect(configPath).toBeDefined()
    if (configPath === undefined) throw new Error('configPath should be defined')

    const written = await fs.readFile(configPath)
    const historyMatch = /set -g history-limit (\d+)/.exec(written)
    expect(historyMatch).not.toBeNull()
    const historyValue = Number(historyMatch?.[1])
    expect(historyValue).toBeGreaterThanOrEqual(50000)
    expect(written).toContain('set -g mouse on')
    // V3 copy path — OSC 52 host clipboard + passthrough + native-blue selection.
    expect(written).toContain('set -g set-clipboard on')
    expect(written).toContain('set -g allow-passthrough on')
    expect(written).toContain("set -g mode-style 'bg=#214283,fg=#ffffff'")
    expect(written).toContain('set -g remain-on-exit on')
    expect(written).toContain('set -g prefix None')
    expect(written).toContain('set -s exit-empty off')
    // Per-source sessions are unattached by design — pin `destroy-unattached
    // off` server-wide before any source session is created, so a user's
    // `~/.tmux.conf` cannot reap them behind our back.
    expect(written).toContain('set -g destroy-unattached off')
  })

  it('writes the pane-border focus styling so the focused pane is visible (P6)', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const createCall = tmux.recordedCalls.find((c) => c.method === 'createSession')
    if (createCall?.method !== 'createSession') throw new Error('expected createSession call')
    const configPath = createCall.opts.configPath
    if (configPath === undefined) throw new Error('configPath should be defined')

    const written = await fs.readFile(configPath)
    expect(written).toContain('set -g pane-border-style fg=brightblack')
    expect(written).toContain('set -g pane-active-border-style fg=cyan')
  })

  it('passes the config path to createSession via the configPath option', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const createCall = tmux.recordedCalls.find((c) => c.method === 'createSession')
    if (createCall?.method !== 'createSession') throw new Error('expected createSession call')
    expect(createCall.opts.configPath).toMatch(/init\.tmux\.conf$/)
  })
})

describe('initOrchSession wipes key tables before installing bindings', () => {
  it('wipes all four key tables before installing any bindings', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const calls = tmux.recordedCalls
    const lastUnbindIdx = calls.findLastIndex((c) => c.method === 'unbindKey')
    const firstBindIdx = calls.findIndex((c) => c.method === 'bindKey')

    expect(lastUnbindIdx).toBeGreaterThanOrEqual(0)
    expect(firstBindIdx).toBeGreaterThanOrEqual(0)
    expect(firstBindIdx).toBeGreaterThan(lastUnbindIdx)

    const wipedTables = calls
      .filter((c) => c.method === 'unbindKey')
      .map((c) => (c.method === 'unbindKey' ? c.opts.table : ''))
    expect(wipedTables).toEqual(['root', 'prefix', 'copy-mode', 'copy-mode-vi'])
  })
})

describe('initOrchSession installs the root allowlist followed by the copy-mode allowlist', () => {
  it('binds MouseDrag1Border to resize-pane -M as the first root-table binding', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const first = binds[0]
    if (first?.method !== 'bindKey') throw new Error('expected bindKey call')
    expect(first.opts.table).toBe('root')
    expect(first.opts.key).toBe('MouseDrag1Border')
    expect(first.opts.command).toEqual(['resize-pane', '-M'])
  })

  it('installs the seven root-table bindings first, in MouseDrag1Border, MouseDown, M-Left, M-Right, WheelUpPane, WheelDownPane, MouseDrag1Pane order', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const rootBinds = binds.slice(0, 7)
    const keys = rootBinds.map((c) => (c.method === 'bindKey' ? c.opts.key : ''))
    expect(keys).toEqual([
      'MouseDrag1Border',
      'MouseDown1Pane',
      'M-Left',
      'M-Right',
      'WheelUpPane',
      'WheelDownPane',
      'MouseDrag1Pane',
    ])

    const tables = rootBinds.map((c) => (c.method === 'bindKey' ? c.opts.table : ''))
    expect(tables).toEqual([
      'root',
      'root',
      'root-no-prefix',
      'root-no-prefix',
      'root',
      'root',
      'root',
    ])
  })

  it('WheelUpPane uses the smart-wheel rule that falls back to copy-mode -e on a normal text pane', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const upBind = binds.find((c) => c.method === 'bindKey' && c.opts.key === 'WheelUpPane')
    if (upBind?.method !== 'bindKey') throw new Error('expected WheelUpPane bindKey call')
    const command = upBind.opts.command
    expect(command[0]).toBe('if-shell')
    expect(command[1]).toBe('-F')
    expect(command[2]).toBe('#{?mouse_any_flag,1,0}')
    expect(command[3]).toBe('send-keys -M')
    expect(command[4]).toBe('if-shell -F "#{?alternate_on,1,0}" "send-keys -M" "copy-mode -e"')
  })

  it('WheelDownPane uses the smart-wheel rule WITHOUT a copy-mode fallback (no surprise enter on scroll-down at the live tail)', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const downBind = binds.find((c) => c.method === 'bindKey' && c.opts.key === 'WheelDownPane')
    if (downBind?.method !== 'bindKey') throw new Error('expected WheelDownPane bindKey call')
    const command = downBind.opts.command
    expect(command[0]).toBe('if-shell')
    expect(command[1]).toBe('-F')
    expect(command[2]).toBe('#{?mouse_any_flag,1,0}')
    expect(command[3]).toBe('send-keys -M')
    // Inner if-shell has the alt-screen forward branch only — no copy-mode -e
    // else, so the live-tail case is an explicit no-op.
    expect(command[4]).toBe('if-shell -F "#{?alternate_on,1,0}" "send-keys -M"')
    expect(command[4]).not.toContain('copy-mode')
  })

  it('MouseDrag1Pane uses the smart-drag rule: forward to a mouse-capturing agent, else enter copy-mode -M (V3 steps-pane copy)', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const dragBind = binds.find((c) => c.method === 'bindKey' && c.opts.key === 'MouseDrag1Pane')
    if (dragBind?.method !== 'bindKey') throw new Error('expected MouseDrag1Pane bindKey call')
    const command = dragBind.opts.command
    expect(command[0]).toBe('if-shell')
    expect(command[1]).toBe('-F')
    expect(command[2]).toBe('#{?mouse_any_flag,1,0}')
    // Agent owns the mouse → forward the drag; plain pane → begin a copy-mode
    // mouse selection. The drag-END yank lives in the copy-mode tables.
    expect(command[3]).toBe('send-keys -M')
    expect(command[4]).toBe('copy-mode -M')
  })

  it('after the root bindings, installs the copy-mode allowlist under both copy-mode and copy-mode-vi tables', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const copyModeBinds = binds.slice(7)
    const tables = new Set(copyModeBinds.map((c) => (c.method === 'bindKey' ? c.opts.table : '')))
    expect(tables).toEqual(new Set(['copy-mode', 'copy-mode-vi']))

    // Same key/command set under each table, so total count is 2 × per-table.
    expect(copyModeBinds.length % 2).toBe(0)
    expect(copyModeBinds.length).toBeGreaterThanOrEqual(2 * 7) // at minimum: exit + scroll keys
  })

  it('the copy-mode allowlist binds q, Escape, and C-c to the cancel command so the user can always exit copy-mode', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
      for (const key of ['q', 'Escape', 'C-c'] as const) {
        const match = binds.find(
          (c) => c.method === 'bindKey' && c.opts.table === table && c.opts.key === key,
        )
        if (match?.method !== 'bindKey') {
          throw new Error(`expected ${table}/${key} bindKey call`)
        }
        expect(match.opts.command).toEqual(['send-keys', '-X', 'cancel'])
      }
    }
  })

  it('the copy-mode allowlist binds j/k/Up/Down/PageUp/PageDown/g/G and the wheel to the documented scroll commands', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    const expectations: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['j', ['send-keys', '-X', 'cursor-down']],
      ['k', ['send-keys', '-X', 'cursor-up']],
      ['Down', ['send-keys', '-X', 'cursor-down']],
      ['Up', ['send-keys', '-X', 'cursor-up']],
      ['PageDown', ['send-keys', '-X', 'page-down']],
      ['PageUp', ['send-keys', '-X', 'page-up']],
      ['g', ['send-keys', '-X', 'history-top']],
      ['G', ['send-keys', '-X', 'history-bottom']],
      ['WheelUpPane', ['send-keys', '-X', '-N', '3', 'scroll-up']],
      ['WheelDownPane', ['send-keys', '-X', '-N', '3', 'scroll-down']],
    ]
    for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
      for (const [key, command] of expectations) {
        const match = binds.find(
          (c) => c.method === 'bindKey' && c.opts.table === table && c.opts.key === key,
        )
        if (match?.method !== 'bindKey') {
          throw new Error(`expected ${table}/${key} bindKey call`)
        }
        expect(match.opts.command).toEqual(command)
      }
    }
  })

  it('the copy-mode allowlist binds MouseDragEnd1Pane to copy-selection-and-cancel under both tables (V3 drag-end yank)', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    // The drag-END event must route through the copy-mode tables, not root —
    // MouseDrag1Pane has already entered copy-mode via `copy-mode -M`, so
    // binding the end in root silently loses the yank (Phase 0 finding #1).
    for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
      const match = binds.find(
        (c) =>
          c.method === 'bindKey' && c.opts.table === table && c.opts.key === 'MouseDragEnd1Pane',
      )
      if (match?.method !== 'bindKey') {
        throw new Error(`expected ${table}/MouseDragEnd1Pane bindKey call`)
      }
      expect(match.opts.command).toEqual(['send-keys', '-X', 'copy-selection-and-cancel'])
    }
  })
})

describe('initOrchSession installs the discoverability hint and lifecycle hook', () => {
  it('installs the persistent status-right hint after the bindings are in place', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const calls = tmux.recordedCalls
    const lastBindIdx = calls.findLastIndex((c) => c.method === 'bindKey')
    const statusRightIdx = calls.findIndex(
      (c) => c.method === 'setOption' && c.opts.name === 'status-right',
    )

    expect(statusRightIdx).toBeGreaterThan(lastBindIdx)
    const hint = calls[statusRightIdx]
    if (hint?.method !== 'setOption') throw new Error('expected setOption call')
    // The status-right hint now leads with in-pane scroll discoverability
    // (the new primary surface); `logs --latest --follow` lives in the
    // startup banner as the power-user fallback.
    expect(hint.opts.value).toContain('scroll')
    expect(hint.opts.value).toContain('wheel')
    expect(hint.opts.global).toBe(true)
  })

  it('installs the pane-died hook after the bindings so unbind-key cannot wipe it', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const calls = tmux.recordedCalls
    const lastBindIdx = calls.findLastIndex((c) => c.method === 'bindKey')
    const hookIdx = calls.findIndex((c) => c.method === 'setHook')

    expect(hookIdx).toBeGreaterThan(lastBindIdx)
    const hookCall = calls[hookIdx]
    if (hookCall?.method !== 'setHook') throw new Error('expected setHook call')
    expect(hookCall.opts.hook).toBe('pane-died')
    expect(hookCall.opts.command).toContain('pane-exit-#{hook_pane}')
    expect(hookCall.opts.global).toBe(true)
  })
})
