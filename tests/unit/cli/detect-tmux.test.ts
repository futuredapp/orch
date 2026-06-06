// MIGRATED → tests-new/unit/cli/detect-tmux.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import {
  isInsideTmux,
  meetsMinimumTmuxVersion,
  probeTmuxVersion,
} from '../../../src/cli/detect-tmux.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

describe.skip('isInsideTmux', () => {
  it('returns true when TMUX is set to a non-empty string', () => {
    expect(isInsideTmux({ TMUX: '/tmp/tmux-1000/default,12345,0' })).toBe(true)
  })

  it('returns false when TMUX is undefined', () => {
    expect(isInsideTmux({})).toBe(false)
  })

  it('returns false when TMUX is an empty string', () => {
    expect(isInsideTmux({ TMUX: '' })).toBe(false)
  })
})

describe.skip('meetsMinimumTmuxVersion', () => {
  it('accepts tmux 3.3 exactly', () => {
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 3.3', major: 3, minor: 3 })).toBe(true)
  })

  it('accepts any release above 3.3', () => {
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 3.6a', major: 3, minor: 6 })).toBe(true)
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 4.0', major: 4, minor: 0 })).toBe(true)
  })

  it('rejects tmux 3.2 and earlier (smart-wheel requires the mouse_any_flag format from 3.3)', () => {
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 3.2', major: 3, minor: 2 })).toBe(false)
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 3.1c', major: 3, minor: 1 })).toBe(false)
    expect(meetsMinimumTmuxVersion({ raw: 'tmux 2.9', major: 2, minor: 9 })).toBe(false)
  })
})

describe.skip('probeTmuxVersion', () => {
  it('parses the major and minor components of tmux -V output', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-V']).respondWith({ exitCode: 0, stdout: ['tmux 3.6a'] })

    const info = await probeTmuxVersion(proc)

    expect(info?.major).toBe(3)
    expect(info?.minor).toBe(6)
    expect(info?.raw).toBe('tmux 3.6a')
  })

  it('returns undefined when tmux -V exits non-zero', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-V']).respondWith({ exitCode: 1 })

    const info = await probeTmuxVersion(proc)

    expect(info).toBeUndefined()
  })

  it('throws when tmux -V output does not look like a version string', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-V']).respondWith({ exitCode: 0, stdout: ['totally not tmux'] })

    await expect(probeTmuxVersion(proc)).rejects.toThrow('unparseable')
  })
})
