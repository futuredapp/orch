import { describe, expect, it } from 'bun:test'
import { claude } from '../../../../src/runners/claude/index.ts'
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
  it('produces correct argv with defaults (stream-json, verbose) and persists the session', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('hello world'))

    // Autonomous now persists a forkable session (U4): --no-session-persistence
    // is gone, and --session-id rides only when the executor supplies one.
    expect(cmd.argv).toEqual([
      'claude',
      '-p',
      'hello world',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
    expect(cmd.argv).not.toContain('--no-session-persistence')
  })

  it('emits --session-id on the autonomous argv when the executor supplies one (U4)', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(
      ctxFor('hello world', { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    )

    expect(cmd.argv).toContain('--session-id')
    expect(cmd.argv).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(cmd.argv).not.toContain('--no-session-persistence')
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

  it('omits --bare by default', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--bare')
    expect(cmd.argv[0]).toBe('claude')
    expect(cmd.argv[1]).toBe('-p')
  })

  it('includes --bare only when bare is explicitly true', async () => {
    const runner = claude({ bare: true })
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv[0]).toBe('claude')
    expect(cmd.argv[1]).toBe('--bare')
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

    expect(cmd.argv).not.toContain('--bare')
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

  it('lets ctx.env override the interactive FORCE_COLOR extra (mergeEnv contract)', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(
      ctxFor('test', { mode: 'interactive', env: { FORCE_COLOR: '0' } }),
    )

    // ctx.env wins last in mergeEnv. A workflow author can disable Ink's
    // truecolor extra by setting FORCE_COLOR=0 — proves the override seam
    // is wired through buildCommand even though no YAML path uses it yet.
    expect(cmd.env.FORCE_COLOR).toBe('0')
  })
})

describe('claude() permissions option', () => {
  it('expands permissions "bypass" into --permission-mode bypassPermissions on the autonomous argv', async () => {
    const runner = claude({ permissions: 'bypass' })
    const cmd = await runner.buildCommand(ctxFor('test'))

    const idx = cmd.argv.indexOf('--permission-mode')
    expect(idx).toBeGreaterThan(-1)
    expect(cmd.argv[idx + 1]).toBe('bypassPermissions')
  })

  it('expands permissions "bypass" on the interactive argv too', async () => {
    const runner = claude({ permissions: 'bypass' })
    const cmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))

    const idx = cmd.argv.indexOf('--permission-mode')
    expect(idx).toBeGreaterThan(-1)
    expect(cmd.argv[idx + 1]).toBe('bypassPermissions')
  })

  it('omits --permission-mode when permissions is not set', async () => {
    const runner = claude()
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--permission-mode')
  })

  it('keeps flags working and places the permission flag before user flags', async () => {
    const runner = claude({ permissions: 'bypass', flags: ['--allowedTools', 'Read'] })
    const cmd = await runner.buildCommand(ctxFor('test'))

    const permIdx = cmd.argv.indexOf('--permission-mode')
    const flagsIdx = cmd.argv.indexOf('--allowedTools')

    expect(permIdx).toBeGreaterThan(-1)
    expect(flagsIdx).toBeGreaterThan(-1)
    expect(permIdx).toBeLessThan(flagsIdx)
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
