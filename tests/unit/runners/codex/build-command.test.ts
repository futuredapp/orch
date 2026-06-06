// MIGRATED → tests-new/unit/runners/codex/build-command.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
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

describe.skip('codex() factory', () => {
  it('returns a runner with name "codex" and structuredOutput true', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(runner.name).toBe('codex')
    expect(runner.supports.structuredOutput).toBe(true)
    expect(runner.supports.interactive).toBe(true)
  })

  it('returns a frozen runner object', () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(Object.isFrozen(runner)).toBe(true)
  })
})

describe.skip('buildCommand', () => {
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
    expect(cmd.env.FORCE_COLOR).toBeUndefined()
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

describe.skip('buildCommand flag denylist', () => {
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

describe.skip('checkCodexVersion (via buildCommand)', () => {
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

  // Regression: the public `codex({...})` one-argument call form (mirroring
  // `claude({...})`) must self-provide its services. Before the fix, omitting
  // `deps` captured `undefined` and buildCommand threw a TypeError
  // ("undefined is not an object (evaluating 'deps.ps')") the first time it
  // ran — which surfaced only deep into a workflow, at the codex review step.
  it('reaches the version check instead of throwing on undefined deps when constructed with only options', async () => {
    const runner = codex({ sandbox: 'workspace-write' })

    // Empty PATH makes the spawned `codex --version` fail fast (ENOENT) so the
    // self-provided ProcessService never runs a real subprocess. We assert only
    // that the failure is NOT the old `deps`-undefined TypeError — i.e. the one-
    // arg form now self-provides its services and reaches real version-check code.
    const savedPath = process.env.PATH
    process.env.PATH = ''
    let caught: unknown
    try {
      await runner.buildCommand(ctxFor('review the diff'))
    } catch (err) {
      caught = err
    } finally {
      process.env.PATH = savedPath
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(TypeError)
    expect(String(caught)).not.toContain('deps')
  })
})

describe.skip('buildCommand interactive mode', () => {
  it('builds the default interactive argv with --full-auto, --no-alt-screen, the -- separator, and the prompt', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('hello world', { mode: 'interactive' }))

    // No `exec`, no `--json`, no `--skip-git-repo-check`, no `--ephemeral` —
    // those are exec-only and would error against the interactive subcommand.
    // `--no-alt-screen` is the default for interactive mode (composes with
    // the right pane's smart-wheel binding for in-pane scrollback).
    expect(cmd.argv).toEqual(['codex', '--full-auto', '--no-alt-screen', '--', 'hello world'])
  })

  it('adds --dangerously-bypass-hook-trust for interactive auto-stop runs', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(
      ctxFor('hello world', { mode: 'interactive', autoStop: true }),
    )

    expect(cmd.argv).toEqual([
      'codex',
      '--full-auto',
      '--no-alt-screen',
      '--dangerously-bypass-hook-trust',
      '--',
      'hello world',
    ])
  })

  it('does not add --dangerously-bypass-hook-trust for interactive runs without auto-stop', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('hello world', { mode: 'interactive' }))

    expect(cmd.argv).not.toContain('--dangerously-bypass-hook-trust')
  })

  it('does not add --dangerously-bypass-hook-trust to autonomous argv', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(
      ctxFor('hello world', { mode: 'autonomous', autoStop: true }),
    )

    expect(cmd.argv).not.toContain('--dangerously-bypass-hook-trust')
  })

  it('does not duplicate --dangerously-bypass-hook-trust when a workflow already passes it', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--dangerously-bypass-hook-trust'] }, deps)
    const cmd = await runner.buildCommand(ctxFor('p', { mode: 'interactive', autoStop: true }))

    const occurrences = cmd.argv.filter((a) => a === '--dangerously-bypass-hook-trust').length
    expect(occurrences).toBe(1)
  })

  it('keeps --no-alt-screen out of the autonomous (exec) argv', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('hello', { mode: 'autonomous' }))

    expect(cmd.argv).not.toContain('--no-alt-screen')
  })

  it('replaces --full-auto with --sandbox <mode> when the user picks a non-default sandbox', async () => {
    const deps = makeDeps()
    const runner = codex({ sandbox: 'read-only' }, deps)
    const cmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))

    expect(cmd.argv).not.toContain('--full-auto')
    expect(cmd.argv).toContain('--sandbox')
    expect(cmd.argv).toContain('read-only')
  })

  it('places the --no-alt-screen default before user flags, then extraArgs, then the -- separator', async () => {
    const deps = makeDeps()
    const runner = codex({ model: 'o4-mini', flags: ['--ask-for-approval', 'on-request'] }, deps)
    const cmd = await runner.buildCommand(ctxFor('p', { mode: 'interactive', extraArgs: ['-q'] }))

    expect(cmd.argv).toEqual([
      'codex',
      '--full-auto',
      '-m',
      'o4-mini',
      '--no-alt-screen',
      '--ask-for-approval',
      'on-request',
      '-q',
      '--',
      'p',
    ])
  })

  it('treats a user-supplied --no-alt-screen as idempotent: it appears alongside the default without raising', async () => {
    // Codex accepts repeated --no-alt-screen on the CLI (verified empirically
    // in the parity-plan flag matrix). The argv builder doesn't dedupe so
    // workflows that explicitly pass the flag aren't silently dropped.
    const deps = makeDeps()
    const runner = codex({ flags: ['--no-alt-screen'] }, deps)
    const cmd = await runner.buildCommand(ctxFor('p', { mode: 'interactive' }))

    const occurrences = cmd.argv.filter((a) => a === '--no-alt-screen').length
    expect(occurrences).toBe(2)
  })

  it('throws synchronously when ctx.schema is set and ctx.mode is interactive', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)

    expect(
      runner.buildCommand(
        ctxFor('test', {
          mode: 'interactive',
          schema: { jsonSchema: '{"type":"object"}' },
        }),
      ),
    ).rejects.toThrow(/--output-schema.*exec-only/)
  })

  it('applies the same flag denylist in interactive mode as in autonomous mode', async () => {
    const deps = makeDeps()
    const runner = codex({ flags: ['--config', 'evil.toml'] }, deps)

    expect(runner.buildCommand(ctxFor('test', { mode: 'interactive' }))).rejects.toThrow(
      /flag "--config" is on the denylist/,
    )
  })

  it('reuses the versionChecked closure flag across modes so the preflight runs once total', async () => {
    const deps = makeDeps()
    let spawnCount = 0
    const origSpawn = deps.ps.spawn.bind(deps.ps)
    deps.ps.spawn = (opts) => {
      if (opts.argv[0] === 'codex' && opts.argv[1] === '--version') spawnCount++
      return origSpawn(opts)
    }

    const runner = codex({}, deps)
    await runner.buildCommand(ctxFor('first'))
    await runner.buildCommand(ctxFor('second', { mode: 'interactive' }))

    expect(spawnCount).toBe(1)
  })

  it('sets FORCE_COLOR=3 in env for interactive mode', async () => {
    const deps = makeDeps()
    const runner = codex({}, deps)
    const cmd = await runner.buildCommand(ctxFor('test', { mode: 'interactive' }))

    expect(cmd.env.FORCE_COLOR).toBe('3')
  })
})
