import { describe, expect, it } from 'bun:test'
import { parseArgv } from '../../../src/cli/main.ts'

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
