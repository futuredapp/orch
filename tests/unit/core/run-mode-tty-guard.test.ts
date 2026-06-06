// resolveRunMode's TTY guard — explicit --mode=two-pane without a TTY is an
// error UNLESS --no-attach was passed (CI / screenshot tests). Adjacent to
// the existing run-mode.test.ts; kept separate so the intent of the guard is
// legible in one file.

import { describe, expect, it } from 'bun:test'
import { RunModeError, resolveRunMode } from '../../../src/core/run-mode.ts'

describe('resolveRunMode — two-pane TTY guard', () => {
  it('two-pane with no TTY and no allowHeadless returns an explicit RunModeError', () => {
    let caught: unknown
    try {
      resolveRunMode({
        flag: 'two-pane',
        ci: false,
        tty: false,
        tmuxAvailable: true,
        tmuxVersionOk: true,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RunModeError)
    expect((caught as Error).message).toContain('requires a TTY')
    expect((caught as Error).message).toContain('--no-attach')
  })

  it('two-pane with no TTY but allowHeadlessTwoPane=true resolves to two-pane via flag', () => {
    const result = resolveRunMode({
      flag: 'two-pane',
      ci: false,
      tty: false,
      tmuxAvailable: true,
      tmuxVersionOk: true,
      allowHeadlessTwoPane: true,
    })
    expect(result.mode).toBe('two-pane')
    expect(result.source).toBe('flag')
  })

  it('two-pane with a TTY is unaffected by allowHeadlessTwoPane', () => {
    const result = resolveRunMode({
      flag: 'two-pane',
      ci: false,
      tty: true,
      tmuxAvailable: true,
      tmuxVersionOk: true,
    })
    expect(result.mode).toBe('two-pane')
  })
})
