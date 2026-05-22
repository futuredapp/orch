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
  it('writes a config file containing history-limit 0, mouse on, remain-on-exit on, prefix None, and exit-empty off', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const createCall = tmux.recordedCalls.find((c) => c.method === 'createSession')
    if (createCall?.method !== 'createSession') throw new Error('expected createSession call')
    const configPath = createCall.opts.configPath
    expect(configPath).toBeDefined()
    if (configPath === undefined) throw new Error('configPath should be defined')

    const written = await fs.readFile(configPath)
    expect(written).toContain('set -g history-limit 0')
    expect(written).toContain('set -g mouse on')
    expect(written).toContain('set -g remain-on-exit on')
    expect(written).toContain('set -g prefix None')
    expect(written).toContain('set -s exit-empty off')
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

describe('initOrchSession installs the four-item allowlist in order', () => {
  it('binds MouseDrag1Border to resize-pane -M on the root table', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    expect(binds).toHaveLength(4)
    const first = binds[0]
    if (first?.method !== 'bindKey') throw new Error('expected bindKey call')
    expect(first.opts.table).toBe('root')
    expect(first.opts.key).toBe('MouseDrag1Border')
    expect(first.opts.command).toEqual(['resize-pane', '-M'])
  })

  it('installs exactly the four allowlist bindings in MouseDrag, MouseDown, M-Left, M-Right order', async () => {
    const fs = new FakeFsService()
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, fs, baseOpts)

    const binds = tmux.recordedCalls.filter((c) => c.method === 'bindKey')
    expect(binds).toHaveLength(4)
    const keys = binds.map((c) => (c.method === 'bindKey' ? c.opts.key : ''))
    expect(keys).toEqual(['MouseDrag1Border', 'MouseDown1Pane', 'M-Left', 'M-Right'])

    const tables = binds.map((c) => (c.method === 'bindKey' ? c.opts.table : ''))
    expect(tables).toEqual(['root', 'root', 'root-no-prefix', 'root-no-prefix'])
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
    expect(hint.opts.value).toContain('logs --latest --follow')
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
