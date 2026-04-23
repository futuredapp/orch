import { describe, expect, it } from 'bun:test'
import {
  detectCi,
  isRunMode,
  RunModeError,
  resolveRunMode,
  SINGLE_PANE_DEFERRED_MESSAGE,
} from '../../../src/core/run-mode.ts'

describe('resolveRunMode', () => {
  it('prefers the explicit flag when supplied', () => {
    const result = resolveRunMode({
      flag: 'plain',
      ci: true,
      tty: true,
      tmuxAvailable: true,
      tmuxVersionOk: true,
    })

    expect(result.mode).toBe('plain')
    expect(result.source).toBe('flag')
  })

  it('falls to plain when CI=true and no flag is given', () => {
    const result = resolveRunMode({
      ci: true,
      tty: false,
      tmuxAvailable: true,
      tmuxVersionOk: true,
    })

    expect(result).toEqual({ mode: 'plain', source: 'env', reason: 'CI=true' })
  })

  it('picks two-pane when TTY present and tmux ≥ 3.2', () => {
    const result = resolveRunMode({
      ci: false,
      tty: true,
      tmuxAvailable: true,
      tmuxVersionOk: true,
    })

    expect(result.mode).toBe('two-pane')
    expect(result.source).toBe('auto')
  })

  it('falls to plain when tmux version is too old', () => {
    const result = resolveRunMode({
      ci: false,
      tty: true,
      tmuxAvailable: true,
      tmuxVersionOk: false,
    })

    expect(result).toMatchObject({ mode: 'plain', source: 'auto' })
    expect(result.reason).toContain('tmux')
  })

  it('falls to plain when TTY present but tmux missing', () => {
    const result = resolveRunMode({
      ci: false,
      tty: true,
      tmuxAvailable: false,
      tmuxVersionOk: false,
    })

    expect(result).toMatchObject({ mode: 'plain', source: 'auto' })
  })

  it('falls to plain when no TTY is attached', () => {
    const result = resolveRunMode({
      ci: false,
      tty: false,
      tmuxAvailable: true,
      tmuxVersionOk: true,
    })

    expect(result).toMatchObject({ mode: 'plain', source: 'auto' })
    expect(result.reason).toContain('TTY')
  })

  it('never auto-selects single-pane', () => {
    // every autodetect branch we exercise lands on plain or two-pane
    const combos = [
      { ci: false, tty: true, tmuxAvailable: true, tmuxVersionOk: true },
      { ci: false, tty: true, tmuxAvailable: true, tmuxVersionOk: false },
      { ci: false, tty: true, tmuxAvailable: false, tmuxVersionOk: false },
      { ci: false, tty: false, tmuxAvailable: false, tmuxVersionOk: false },
      { ci: true, tty: true, tmuxAvailable: true, tmuxVersionOk: true },
    ]

    for (const c of combos) {
      expect(resolveRunMode(c).mode).not.toBe('single-pane')
    }
  })

  it('throws with the deferral message for explicit --mode=single-pane', () => {
    expect(() =>
      resolveRunMode({
        flag: 'single-pane',
        ci: false,
        tty: true,
        tmuxAvailable: true,
        tmuxVersionOk: true,
      }),
    ).toThrow(SINGLE_PANE_DEFERRED_MESSAGE)
  })

  it('throws on explicit --mode=two-pane when tmux is missing', () => {
    let caught: unknown
    try {
      resolveRunMode({
        flag: 'two-pane',
        ci: false,
        tty: true,
        tmuxAvailable: false,
        tmuxVersionOk: false,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RunModeError)
    expect((caught as Error).message).toContain('tmux')
  })

  it('throws on explicit --mode=two-pane when tmux is too old', () => {
    let caught: unknown
    try {
      resolveRunMode({
        flag: 'two-pane',
        ci: false,
        tty: true,
        tmuxAvailable: true,
        tmuxVersionOk: false,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RunModeError)
    expect((caught as Error).message).toContain('3.2')
  })
})

describe('isRunMode', () => {
  it('accepts known modes', () => {
    expect(isRunMode('plain')).toBe(true)
    expect(isRunMode('single-pane')).toBe(true)
    expect(isRunMode('two-pane')).toBe(true)
  })

  it('rejects unknown strings', () => {
    expect(isRunMode('tui')).toBe(false)
    expect(isRunMode('')).toBe(false)
  })
})

describe('detectCi', () => {
  it('returns true for CI=true', () => {
    expect(detectCi({ CI: 'true' })).toBe(true)
  })

  it('returns false for CI=false (some test runners set this)', () => {
    expect(detectCi({ CI: 'false' })).toBe(false)
  })

  it('returns true for GitHub Actions', () => {
    expect(detectCi({ GITHUB_ACTIONS: 'true' })).toBe(true)
  })

  it('returns true for GitLab CI', () => {
    expect(detectCi({ GITLAB_CI: 'true' })).toBe(true)
  })

  it('returns false for an empty env', () => {
    expect(detectCi({})).toBe(false)
  })
})
