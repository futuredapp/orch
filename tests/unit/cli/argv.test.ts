// MIGRATED → tests-new/unit/cli/argv.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { ArgvError, parseArgv } from '../../../src/cli/main.ts'

describe.skip('parseArgv', () => {
  it('parses a command with a positional argument', () => {
    const result = parseArgv(['run', 'deploy'])

    expect(result.command).toBe('run')
    expect(result.positional).toBe('deploy')
    expect(result.help).toBe(false)
  })

  it('parses a command without a positional argument', () => {
    const result = parseArgv(['runs'])

    expect(result.command).toBe('runs')
    expect(result.positional).toBe('')
    expect(result.help).toBe(false)
  })

  it('returns undefined command when no arguments are given', () => {
    const result = parseArgv([])

    expect(result.command).toBeUndefined()
    expect(result.positional).toBe('')
  })

  it('parses --help flag', () => {
    const result = parseArgv(['--help'])

    expect(result.help).toBe(true)
  })

  it('parses -h shorthand', () => {
    const result = parseArgv(['-h'])

    expect(result.help).toBe(true)
  })

  it('parses --help alongside a command', () => {
    const result = parseArgv(['run', '--help'])

    expect(result.command).toBe('run')
    expect(result.help).toBe(true)
  })

  it('ignores unknown flags without throwing', () => {
    const result = parseArgv(['run', 'deploy', '--unknown'])

    expect(result.command).toBe('run')
    expect(result.positional).toBe('deploy')
  })

  it('parses dry-run as a single command word', () => {
    const result = parseArgv(['dry-run', 'my-wf'])

    expect(result.command).toBe('dry-run')
    expect(result.positional).toBe('my-wf')
  })
})

describe.skip('parseArgv prompt handling', () => {
  it('captures a positional prompt as args.prompt', () => {
    const result = parseArgv(['run', 'brainstorm', 'think hard about X'])

    expect(result.command).toBe('run')
    expect(result.positional).toBe('brainstorm')
    expect(result.args).toEqual({ prompt: 'think hard about X' })
  })

  it('captures a --prompt flag as args.prompt', () => {
    const result = parseArgv(['run', 'brainstorm', '--prompt', 'think hard'])

    expect(result.args).toEqual({ prompt: 'think hard' })
  })

  it('leaves args empty when no prompt is supplied', () => {
    const result = parseArgv(['run', 'brainstorm'])

    expect(result.args).toEqual({})
  })

  it('treats an empty-string positional prompt as distinct from undefined', () => {
    const result = parseArgv(['run', 'brainstorm', ''])

    expect(result.args).toEqual({ prompt: '' })
  })

  it('treats an empty-string --prompt flag as distinct from undefined', () => {
    const result = parseArgv(['run', 'brainstorm', '--prompt', ''])

    expect(result.args).toEqual({ prompt: '' })
  })

  it('throws ArgvError when both positional and --prompt are given', () => {
    expect(() => parseArgv(['run', 'brainstorm', 'a', '--prompt', 'b'])).toThrow(ArgvError)
  })

  it('throws ArgvError when more than one positional prompt is given', () => {
    expect(() => parseArgv(['run', 'brainstorm', 'a', 'b'])).toThrow(ArgvError)
  })

  it('accepts a prompt on the resume command', () => {
    const result = parseArgv(['resume', 'r-2026-04-14-645920-3h', 'new prompt'])

    expect(result.command).toBe('resume')
    expect(result.positional).toBe('r-2026-04-14-645920-3h')
    expect(result.args).toEqual({ prompt: 'new prompt' })
  })
})

describe.skip('parseArgv mode and format flags', () => {
  it('defaults mode to undefined (auto-detected) and format to text', () => {
    const result = parseArgv(['run', 'brainstorm'])

    expect(result.mode).toBeUndefined()
    expect(result.format).toBe('text')
  })

  it('accepts --mode=plain', () => {
    const result = parseArgv(['run', 'brainstorm', '--mode=plain'])

    expect(result.mode).toBe('plain')
  })

  it('accepts --mode=two-pane', () => {
    const result = parseArgv(['run', 'brainstorm', '--mode=two-pane'])

    expect(result.mode).toBe('two-pane')
  })

  it('accepts --mode=single-pane at parse time (deferral handled later)', () => {
    const result = parseArgv(['run', 'brainstorm', '--mode=single-pane'])

    expect(result.mode).toBe('single-pane')
  })

  it('rejects unknown --mode value', () => {
    expect(() => parseArgv(['run', 'brainstorm', '--mode=bogus'])).toThrow(ArgvError)
  })

  it('accepts --format=json', () => {
    const result = parseArgv(['run', 'brainstorm', '--mode=plain', '--format=json'])

    expect(result.format).toBe('json')
  })

  it('rejects --format=json with --mode=two-pane', () => {
    expect(() => parseArgv(['run', 'brainstorm', '--mode=two-pane', '--format=json'])).toThrow(
      ArgvError,
    )
  })

  it('rejects unknown --format value', () => {
    expect(() => parseArgv(['run', 'brainstorm', '--format=xml'])).toThrow(ArgvError)
  })
})

describe.skip('parseArgv rejects removed flags', () => {
  it('rejects --tmux with a message pointing at --mode=two-pane', () => {
    let caught: unknown
    try {
      parseArgv(['run', 'brainstorm', '--tmux'])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ArgvError)
    expect((caught as Error).message).toContain('--tmux')
    expect((caught as Error).message).toContain('--mode=two-pane')
  })

  it('rejects --observe with a message pointing at --mode=two-pane', () => {
    let caught: unknown
    try {
      parseArgv(['run', 'brainstorm', '--observe'])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ArgvError)
    expect((caught as Error).message).toContain('--observe')
    expect((caught as Error).message).toContain('--mode=two-pane')
  })
})
