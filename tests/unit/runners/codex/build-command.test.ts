import { describe, expect, it } from 'bun:test'
import { CodexVersionError, codex } from '../../../../src/runners/codex/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
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

function makeDeps(): { fs: FakeFsService; ps: FakeProcessService } {
  const fs = new FakeFsService()
  const ps = new FakeProcessService()
  ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.120.0'], exitCode: 0 })
  return { fs, ps }
}

describe('codex() factory', () => {
  it('returns a runner with name "codex" and structuredOutput true', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(runner.name).toBe('codex')
    expect(runner.supports.structuredOutput).toBe(true)
    expect(runner.supports.interactive).toBe(false)
  })

  it('returns a frozen runner object', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(Object.isFrozen(runner)).toBe(true)
  })
})

describe('buildCommand', () => {
  it('produces correct default argv (exec, json, full-auto, skip-git-repo-check, ephemeral, -- separator)', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('hello world'))

    expect(cmd.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--full-auto',
      '--',
      'hello world',
    ])
  })

  it('includes -- separator before prompt', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('some prompt'))

    const dashIdx = cmd.argv.indexOf('--')
    expect(dashIdx).toBeGreaterThan(-1)
    expect(cmd.argv[dashIdx + 1]).toBe('some prompt')
  })

  it('includes -m <model> when provided', async () => {
    const deps = makeDeps()
    const runner = codex({ model: 'o4-mini' }, deps)
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('-m')
    expect(cmd.argv).toContain('o4-mini')
  })

  it('replaces --full-auto with --sandbox <mode> for non-preset modes', async () => {
    const deps = makeDeps()
    const runner = codex({ sandbox: 'read-only' }, deps)
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).not.toContain('--full-auto')
    expect(cmd.argv).toContain('--sandbox')
    expect(cmd.argv).toContain('read-only')
  })

  it('uses --full-auto for the default sandbox mode', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv).toContain('--full-auto')
    expect(cmd.argv).not.toContain('--sandbox')
  })

  it('writes temp schema file via FsService and adds --output-schema when ctx.schema is set', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const ctx = ctxFor('test', { schema: { jsonSchema: '{"type":"object"}' } })
    const cmd = await runner.buildCommand(ctx)

    expect(cmd.argv).toContain('--output-schema')
    const schemaIdx = cmd.argv.indexOf('--output-schema')
    const schemaPath = cmd.argv[schemaIdx + 1]
    expect(schemaPath).toBeDefined()
    expect(schemaPath).toContain('schema.json')

    // Verify temp file was actually written
    if (typeof schemaPath === 'string') {
      const written = await deps.fs.readFile(path(schemaPath))
      expect(written).toBe('{"type":"object"}')
    }
  })

  it('appends user flags and extraArgs after built-in flags but before --', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--verbose'] }, deps)
    const cmd = await runner.buildCommand(ctxFor('test', { extraArgs: ['--extra-flag'] }))

    const verboseIdx = cmd.argv.indexOf('--verbose')
    const extraIdx = cmd.argv.indexOf('--extra-flag')
    const dashIdx = cmd.argv.indexOf('--')

    expect(verboseIdx).toBeGreaterThan(-1)
    expect(extraIdx).toBeGreaterThan(-1)
    expect(dashIdx).toBeGreaterThan(-1)
    expect(verboseIdx).toBeLessThan(dashIdx)
    expect(extraIdx).toBeLessThan(dashIdx)
  })

  it('resets lastAgentMessage between invocations so stale output does not leak', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    // First invocation: parse an agent_message, then turn.completed
    runner.parseEvents(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: '{"old":"data"}' },
      }),
    )
    const firstTerminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )
    expect(
      runner.extractStructuredOutput(
        firstTerminal as import('../../../../src/runners/types.ts').TerminalEvent,
      ),
    ).toEqual({ old: 'data' })

    // Second invocation: buildCommand resets, no new agent_message
    await runner.buildCommand(ctxFor('second'))
    const secondTerminal = runner.parseEvents(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    )
    expect(
      runner.extractStructuredOutput(
        secondTerminal as import('../../../../src/runners/types.ts').TerminalEvent,
      ),
    ).toBeUndefined()
  })
})

describe('buildCommand flag denylist', () => {
  it('rejects --yolo in flags', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--yolo'] }, deps)

    expect(runner.buildCommand(ctxFor('hi'))).rejects.toThrow(/flag "--yolo" is on the denylist/)
  })

  it('rejects --dangerously-bypass-approvals-and-sandbox in flags', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--dangerously-bypass-approvals-and-sandbox'] }, deps)

    expect(runner.buildCommand(ctxFor('hi'))).rejects.toThrow(
      /flag "--dangerously-bypass-approvals-and-sandbox" is on the denylist/,
    )
  })

  it('rejects --config in extraArgs', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(
      runner.buildCommand(ctxFor('hi', { extraArgs: ['--config', '/tmp/evil.toml'] })),
    ).rejects.toThrow(/flag "--config" is on the denylist/)
  })

  it('rejects --sandbox in extraArgs', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(
      runner.buildCommand(ctxFor('hi', { extraArgs: ['--sandbox', 'danger-full-access'] })),
    ).rejects.toThrow(/flag "--sandbox" is on the denylist/)
  })

  it('rejects -c in extraArgs', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(
      runner.buildCommand(ctxFor('hi', { extraArgs: ['-c', 'approval_policy="never"'] })),
    ).rejects.toThrow(/flag "-c" is on the denylist/)
  })

  it('rejects --approval-mode in flags', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--approval-mode', 'never'] }, deps)

    expect(runner.buildCommand(ctxFor('hi'))).rejects.toThrow(
      /flag "--approval-mode" is on the denylist/,
    )
  })

  it('rejects --config=path prefix match', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--config=/tmp/evil.toml'] }, deps)

    expect(runner.buildCommand(ctxFor('hi'))).rejects.toThrow(
      /flag "--config=\/tmp\/evil.toml" is on the denylist/,
    )
  })
})

describe('checkCodexVersion (via buildCommand)', () => {
  it('resolves when version is sufficient', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    const cmd = await runner.buildCommand(ctxFor('test'))

    expect(cmd.argv[0]).toBe('codex')
  })

  it('throws CodexVersionError when version is too old', async () => {
    const fs = new FakeFsService()
    const ps = new FakeProcessService()
    ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.117.0'], exitCode: 0 })
    const runner = codex({}, { fs, ps })

    expect(runner.buildCommand(ctxFor('test'))).rejects.toThrow(CodexVersionError)
  })

  it('throws CodexVersionError with actionable message for old version', async () => {
    const fs = new FakeFsService()
    const ps = new FakeProcessService()
    ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.117.0'], exitCode: 0 })
    const runner = codex({}, { fs, ps })

    expect(runner.buildCommand(ctxFor('test'))).rejects.toThrow(
      /Upgrade with: npm i -g @openai\/codex/,
    )
  })

  it('throws CodexVersionError when version output is unparseable', async () => {
    const fs = new FakeFsService()
    const ps = new FakeProcessService()
    ps.when(['codex', '--version']).respondWith({ stdout: ['unknown'], exitCode: 0 })
    const runner = codex({}, { fs, ps })

    expect(runner.buildCommand(ctxFor('test'))).rejects.toThrow(CodexVersionError)
  })

  it('only checks version once across multiple buildCommand calls', async () => {
    const deps = makeDeps()
    let spawnCount = 0
    const origSpawn = deps.ps.spawn.bind(deps.ps)
    deps.ps.spawn = (opts) => {
      if (opts.argv[0] === 'codex' && opts.argv[1] === '--version') spawnCount++
      return origSpawn(opts)
    }

    const runner = codex({}, deps)
    await runner.buildCommand(ctxFor('first'))
    await runner.buildCommand(ctxFor('second'))

    expect(spawnCount).toBe(1)
  })
})
