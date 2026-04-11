import { describe, expect, it } from 'bun:test'
import { buildClaudeEnv, claude } from '../../../../src/runners/claude/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { path } from '../../../../src/services/types.ts'

function ctxFor(prompt: string, overrides?: Partial<RunnerContext>): RunnerContext {
  return {
    cwd: path('/tmp/work'),
    env: {},
    prompt,
    extraArgs: [],
    ...overrides,
  }
}

describe('claude() factory', () => {
  it('returns a runner with name "claude" and structuredOutput false', () => {
    const runner = claude()

    expect(runner.name).toBe('claude')
    expect(runner.supports.structuredOutput).toBe(false)
    expect(runner.supports.interactive).toBe(false)
  })

  it('returns a frozen runner object', () => {
    const runner = claude()

    expect(Object.isFrozen(runner)).toBe(true)
  })

  it('accepts all options without error', () => {
    const runner = claude({
      model: 'claude-sonnet-4-20250514',
      maxTurns: 5,
      bare: false,
      flags: ['--allowedTools', 'Read,Write'],
    })

    expect(runner.name).toBe('claude')
  })
})

describe('buildCommand', () => {
  it('produces correct argv with defaults (bare, stream-json, verbose, no-session-persistence)', () => {
    const runner = claude()
    const cmd = runner.buildCommand(ctxFor('hello world'))

    expect(cmd.argv).toEqual([
      'claude',
      '--bare',
      '-p',
      'hello world',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
    ])
  })

  it('includes --model when provided', () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514' })
    const cmd = runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('--model')
    expect(cmd.argv).toContain('claude-sonnet-4-20250514')
  })

  it('includes --max-turns when provided', () => {
    const runner = claude({ maxTurns: 3 })
    const cmd = runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('--max-turns')
    expect(cmd.argv).toContain('3')
  })

  it('omits --bare when bare is false', () => {
    const runner = claude({ bare: false })
    const cmd = runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--bare')
    expect(cmd.argv[0]).toBe('claude')
    expect(cmd.argv[1]).toBe('-p')
  })

  it('appends flags before extraArgs, extraArgs last', () => {
    const runner = claude({ flags: ['--allowedTools', 'Read'] })
    const cmd = runner.buildCommand(ctxFor('test', { extraArgs: ['--extra-flag'] }))

    const flagsIdx = cmd.argv.indexOf('--allowedTools')
    const extraIdx = cmd.argv.indexOf('--extra-flag')

    expect(flagsIdx).toBeGreaterThan(-1)
    expect(extraIdx).toBeGreaterThan(-1)
    expect(flagsIdx).toBeLessThan(extraIdx)
  })

  it('includes --model and --max-turns together when both provided', () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514', maxTurns: 10 })
    const cmd = runner.buildCommand(ctxFor('test'))

    const modelIdx = cmd.argv.indexOf('--model')
    const turnsIdx = cmd.argv.indexOf('--max-turns')

    expect(modelIdx).toBeGreaterThan(-1)
    expect(turnsIdx).toBeGreaterThan(-1)
    expect(cmd.argv[modelIdx + 1]).toBe('claude-sonnet-4-20250514')
    expect(cmd.argv[turnsIdx + 1]).toBe('10')
  })
})

describe('buildClaudeEnv', () => {
  it('includes allowlisted vars from process.env when present', () => {
    const env = buildClaudeEnv({})

    // HOME and PATH should always be present in any real environment
    if (process.env.HOME !== undefined) {
      expect(env.HOME).toBe(process.env.HOME)
    }
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH)
    }
  })

  it('includes ANTHROPIC_ and CLAUDE_ prefixed vars from process.env', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'

    try {
      const env = buildClaudeEnv({})

      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key')
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('excludes non-allowlisted vars like DATABASE_URL', () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://secret'

    try {
      const env = buildClaudeEnv({})

      expect(env.DATABASE_URL).toBeUndefined()
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original
      } else {
        delete process.env.DATABASE_URL
      }
    }
  })

  it('merges ctx.env with higher precedence over allowlist', () => {
    const env = buildClaudeEnv({ HOME: '/custom/home', CUSTOM_VAR: 'custom' })

    expect(env.HOME).toBe('/custom/home')
    expect(env.CUSTOM_VAR).toBe('custom')
  })

  it('produces no undefined values in the result', () => {
    const env = buildClaudeEnv({})

    for (const val of Object.values(env)) {
      expect(val).not.toBeUndefined()
    }
  })
})
