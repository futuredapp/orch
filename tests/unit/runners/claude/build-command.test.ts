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
  it('returns a runner with name "claude", structuredOutput true, and interactive true', () => {
    const runner = claude()

    expect(runner.name).toBe('claude')
    expect(runner.supports.structuredOutput).toBe(true)
    expect(runner.supports.interactive).toBe(true)
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
  it('produces correct argv with defaults (bare, stream-json, verbose, no-session-persistence)', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('hello world'))

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

  it('includes --model when provided', async () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514' })
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('--model')
    expect(cmd.argv).toContain('claude-sonnet-4-20250514')
  })

  it('includes --max-turns when provided', async () => {
    const runner = claude({ maxTurns: 3 })
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('--max-turns')
    expect(cmd.argv).toContain('3')
  })

  it('omits --bare when bare is false', async () => {
    const runner = claude({ bare: false })
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--bare')
    expect(cmd.argv[0]).toBe('claude')
    expect(cmd.argv[1]).toBe('-p')
  })

  it('appends flags before extraArgs, extraArgs last', async () => {
    const runner = claude({ flags: ['--allowedTools', 'Read'] })
    const cmd = await runner.buildCommand(ctxFor('test', { extraArgs: ['--extra-flag'] }))

    const flagsIdx = cmd.argv.indexOf('--allowedTools')
    const extraIdx = cmd.argv.indexOf('--extra-flag')

    expect(flagsIdx).toBeGreaterThan(-1)
    expect(extraIdx).toBeGreaterThan(-1)
    expect(flagsIdx).toBeLessThan(extraIdx)
  })

  it('includes --model and --max-turns together when both provided', async () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514', maxTurns: 10 })
    const cmd = await runner.buildCommand(ctxFor('test'))

    const modelIdx = cmd.argv.indexOf('--model')
    const turnsIdx = cmd.argv.indexOf('--max-turns')

    expect(modelIdx).toBeGreaterThan(-1)
    expect(turnsIdx).toBeGreaterThan(-1)
    expect(cmd.argv[modelIdx + 1]).toBe('claude-sonnet-4-20250514')
    expect(cmd.argv[turnsIdx + 1]).toBe('10')
  })

  it('appends --json-schema flag with serialized JSON Schema when schema is present', async () => {
    const runner = claude()
    const ctx = ctxFor('test', { schema: { jsonSchema: '{"type":"object"}' } })
    const cmd = await runner.buildCommand(ctx)

    const idx = cmd.argv.indexOf('--json-schema')
    expect(idx).toBeGreaterThan(-1)
    expect(cmd.argv[idx + 1]).toBe('{"type":"object"}')
  })

  it('does not append --json-schema flag when schema is absent', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--json-schema')
  })

  it('places --json-schema before user flags and extraArgs', async () => {
    const runner = claude({ flags: ['--allowedTools', 'Read'] })
    const ctx = ctxFor('test', {
      schema: { jsonSchema: '{"type":"object"}' },
      extraArgs: ['--extra'],
    })
    const cmd = await runner.buildCommand(ctx)

    const schemaIdx = cmd.argv.indexOf('--json-schema')
    const flagsIdx = cmd.argv.indexOf('--allowedTools')
    const extraIdx = cmd.argv.indexOf('--extra')

    expect(schemaIdx).toBeGreaterThan(-1)
    expect(schemaIdx).toBeLessThan(flagsIdx)
    expect(schemaIdx).toBeLessThan(extraIdx)
  })

  it('includes both --bare and --json-schema when both are active', async () => {
    const runner = claude({ bare: true })
    const ctx = ctxFor('test', { schema: { jsonSchema: '{"type":"string"}' } })
    const cmd = await runner.buildCommand(ctx)

    expect(cmd.argv).toContain('--bare')
    expect(cmd.argv).toContain('--json-schema')
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

  it('includes ANTHROPIC_ and CLAUDE_ prefixed vars from the injected processEnv', () => {
    const env = buildClaudeEnv({}, { ANTHROPIC_API_KEY: 'sk-test-key' })

    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key')
  })

  it('excludes non-allowlisted vars like DATABASE_URL', () => {
    const env = buildClaudeEnv({}, { DATABASE_URL: 'postgres://secret' })

    expect(env.DATABASE_URL).toBeUndefined()
  })

  it('gives allowlist precedence over ctx.env so callers cannot override PATH', () => {
    const env = buildClaudeEnv(
      { PATH: '/evil/bin', HOME: '/evil/home' },
      {
        PATH: '/usr/bin',
        HOME: '/home/user',
      },
    )

    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/user')
  })

  it('uses the injected processEnv, not the global process.env', () => {
    const stub: Record<string, string | undefined> = {
      PATH: '/stub/bin',
      ANTHROPIC_API_KEY: 'stub-key',
    }

    const env = buildClaudeEnv({}, stub)

    expect(env.PATH).toBe('/stub/bin')
    expect(env.ANTHROPIC_API_KEY).toBe('stub-key')
    expect(env.HOME).toBeUndefined()
  })

  it('produces no undefined values in the result', () => {
    const env = buildClaudeEnv({})

    for (const val of Object.values(env)) {
      expect(val).not.toBeUndefined()
    }
  })

  it('propagates TERM and COLORTERM from processEnv so Claude can pick the right ANSI level', () => {
    const env = buildClaudeEnv({}, { TERM: 'xterm-256color', COLORTERM: 'truecolor' })

    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
  })

  it('propagates IS_SANDBOX from processEnv so sandboxed workflows can signal it', () => {
    const env = buildClaudeEnv({}, { IS_SANDBOX: '1' })

    expect(env.IS_SANDBOX).toBe('1')
  })
})

describe('buildCommand interactive mode', () => {
  it('produces interactive argv with session-id and -- flag terminator', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(
      ctxFor('brainstorm auth', { mode: 'interactive', sessionId: 'abc-123' }),
    )

    expect(cmd.argv).toEqual(['claude', '--session-id', 'abc-123', '--', 'brainstorm auth'])
  })

  it('omits --bare, -p, --output-format, --verbose, --no-session-persistence in interactive mode', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('hello', { mode: 'interactive' }))

    expect(cmd.argv).not.toContain('--bare')
    expect(cmd.argv).not.toContain('-p')
    expect(cmd.argv).not.toContain('--output-format')
    expect(cmd.argv).not.toContain('--verbose')
    expect(cmd.argv).not.toContain('--no-session-persistence')
  })

  it('includes --model in interactive mode when configured', async () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514' })
    const cmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))

    expect(cmd.argv).toContain('--model')
    expect(cmd.argv).toContain('claude-sonnet-4-20250514')
  })

  it('applies flag denylist in interactive mode', () => {
    const runner = claude({ flags: ['--settings', '{"evil":true}'] })

    expect(() => runner.buildCommand(ctxFor('test', { mode: 'interactive' }))).toThrow(/denylist/)
  })

  it('passes --dangerously-skip-permissions through to argv (denylist removed by policy)', async () => {
    const runner = claude({ flags: ['--dangerously-skip-permissions'] })
    const cmd = await runner.buildCommand(ctxFor('hi'))

    expect(cmd.argv).toContain('--dangerously-skip-permissions')
  })

  it('produces autonomous argv unchanged when mode is undefined', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('hello'))

    expect(cmd.argv).toContain('--bare')
    expect(cmd.argv).toContain('-p')
    expect(cmd.argv).toContain('--output-format')
  })

  it('uses buildClaudeEnv for both interactive and autonomous modes', async () => {
    const runner = claude()
    const interactiveCmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))
    const autonomousCmd = await runner.buildCommand(ctxFor('test'))

    // Both should have env set (at minimum PATH/HOME from process.env)
    expect(typeof interactiveCmd.env).toBe('object')
    expect(typeof autonomousCmd.env).toBe('object')
  })

  it('sets FORCE_COLOR=3 in interactive mode so Ink keeps colors under inherit stdio', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))

    expect(cmd.env.FORCE_COLOR).toBe('3')
  })

  it('does not set FORCE_COLOR in autonomous mode where stdout is piped NDJSON', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.env.FORCE_COLOR).toBeUndefined()
  })
})

describe('claude() flag denylist', () => {
  it('rejects --settings in flags', () => {
    const runner = claude({ flags: ['--settings', '/tmp/evil.json'] })

    expect(() => runner.buildCommand(ctxFor('hi'))).toThrow(/flag "--settings" is on the denylist/)
  })

  it('no longer rejects --dangerously-skip-permissions (removed by policy)', async () => {
    const runner = claude({ flags: ['--dangerously-skip-permissions'] })
    const cmd = await runner.buildCommand(ctxFor('hi'))

    expect(cmd.argv).toContain('--dangerously-skip-permissions')
  })

  it('rejects --settings in ctx.extraArgs', () => {
    const runner = claude()

    expect(() =>
      runner.buildCommand(ctxFor('hi', { extraArgs: ['--settings', '{"evil":true}'] })),
    ).toThrow(/flag "--settings" is on the denylist/)
  })

  it('rejects --mcp-config=foo (prefix match) in flags', () => {
    const runner = claude({ flags: ['--mcp-config=/tmp/evil.json'] })

    expect(() => runner.buildCommand(ctxFor('hi'))).toThrow(
      /flag "--mcp-config=\/tmp\/evil.json" is on the denylist/,
    )
  })
})
