import { describe, expect, it } from 'bun:test'
import { ArgvError, parseArgv } from '../../../src/cli/main.ts'

describe('parseArgv', () => {
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

describe('parseArgv prompt handling', () => {
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
    const result = parseArgv(['resume', 'r-2026-04-14-abc123', 'new prompt'])

    expect(result.command).toBe('resume')
    expect(result.positional).toBe('r-2026-04-14-abc123')
    expect(result.args).toEqual({ prompt: 'new prompt' })
  })
})

describe('parseArgv tmux and observe flags', () => {
  it('defaults both tmux and observe to false', () => {
    const result = parseArgv(['run', 'brainstorm'])

    expect(result.tmux).toBe(false)
    expect(result.observe).toBe(false)
  })

  it('sets tmux to true when --tmux is given', () => {
    const result = parseArgv(['run', 'brainstorm', '--tmux'])

    expect(result.tmux).toBe(true)
    expect(result.observe).toBe(false)
  })

  it('treats --observe as implying --tmux', () => {
    const result = parseArgv(['run', 'brainstorm', '--observe'])

    expect(result.observe).toBe(true)
    expect(result.tmux).toBe(true)
  })

  it('allows --tmux and --observe together without conflict', () => {
    const result = parseArgv(['run', 'brainstorm', '--tmux', '--observe'])

    expect(result.observe).toBe(true)
    expect(result.tmux).toBe(true)
  })
})
