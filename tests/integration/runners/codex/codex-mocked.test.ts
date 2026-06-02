import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { codex, isTerminalEvent, runRunner } from '../../../../src/runners/index.ts'
import type { RunnerContext, RunnerEvent, TranscriptLine } from '../../../../src/runners/types.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { path } from '../../../../src/services/types.ts'

function ctxFor(prompt: string, overrides?: Partial<RunnerContext>): RunnerContext {
  return { cwd: path('/tmp/work'), env: {}, prompt, extraArgs: [], ...overrides }
}

function loadFixtureLines(name: string): string[] {
  const filePath = resolve(import.meta.dir, '../../../_support/fixtures/codex', name)
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

function makeDeps(): {
  fs: FakeFsService
  ps: FakeProcessService
  clock: FakeClock
} {
  const fs = new FakeFsService()
  const ps = new FakeProcessService()
  const clock = new FakeClock(1000)
  ps.when(['codex', '--version']).respondWith({ stdout: ['codex 0.120.0'], exitCode: 0 })
  return { fs, ps, clock }
}

describe('CodexRunner mocked integration', () => {
  it('round-trips simple-success.jsonl through runRunner with correct events and terminal', async () => {
    const { fs, ps, clock } = makeDeps()
    const runner = codex({}, { fs, ps })
    const ctx = ctxFor('Reply with exactly: OK')

    const cmd = await runner.buildCommand(ctx)
    const fixtureLines = loadFixtureLines('simple-success.jsonl')
    ps.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const resultPromise = runRunner(runner, ctx, { processService: ps, clock })
    clock.advance(500)
    const result = await resultPromise

    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBe(500)

    const output = runner.extractStructuredOutput(result.finalEvent)
    expect(output).toBe('OK')
  })

  it('round-trips with-output-schema.jsonl with structured output parsed as JSON', async () => {
    const { fs, ps, clock } = makeDeps()
    const runner = codex({}, { fs, ps })
    const ctx = ctxFor('Analyze risks', {
      schema: { jsonSchema: '{"type":"object","properties":{"title":{"type":"string"}}}' },
    })

    // FakeFsService.tempDir returns /tmp/codex-schema{N} — first call is N=1.
    // runRunner calls buildCommand internally which writes the schema temp file.
    const expectedArgv = [
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
      '--output-schema',
      '/tmp/codex-schema1/schema.json',
      '--',
      'Analyze risks',
    ]
    const fixtureLines = loadFixtureLines('with-output-schema.jsonl')
    ps.when(expectedArgv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const resultPromise = runRunner(runner, ctx, { processService: ps, clock })
    clock.advance(300)
    const result = await resultPromise

    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)

    const output = runner.extractStructuredOutput(result.finalEvent)
    expect(output).toEqual({ title: 'Analysis', items: ['risk-a', 'risk-b'], count: 2 })
  })

  it('round-trips turn-failed.jsonl with terminal error and message present', async () => {
    const { fs, ps, clock } = makeDeps()
    const runner = codex({}, { fs, ps })
    const ctx = ctxFor('Do something complex')

    const cmd = await runner.buildCommand(ctx)
    const fixtureLines = loadFixtureLines('turn-failed.jsonl')
    ps.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 1 })

    const result = await runRunner(runner, ctx, { processService: ps, clock })

    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('error')

    if (result.finalEvent.type === 'error') {
      expect(result.finalEvent.message).toBe('Rate limit exceeded')
    }

    expect(result.exitCode).toBe(1)
  })

  it('produces the correct argv shape for the spawned process', async () => {
    const { fs, ps } = makeDeps()
    const runner = codex({ model: 'o4-mini', sandbox: 'read-only' }, { fs, ps })
    const ctx = ctxFor('test prompt')

    const cmd = await runner.buildCommand(ctx)

    expect(cmd.argv[0]).toBe('codex')
    expect(cmd.argv[1]).toBe('exec')
    expect(cmd.argv).toContain('--json')
    expect(cmd.argv).toContain('--skip-git-repo-check')
    expect(cmd.argv).not.toContain('--ephemeral')
    expect(cmd.argv).toContain('--sandbox')
    expect(cmd.argv).toContain('read-only')
    expect(cmd.argv).toContain('-m')
    expect(cmd.argv).toContain('o4-mini')

    // Prompt comes after --
    const dashIdx = cmd.argv.indexOf('--')
    expect(dashIdx).toBeGreaterThan(-1)
    expect(cmd.argv[dashIdx + 1]).toBe('test prompt')
  })

  it('formats command_execution and agent_message into the expected transcript lines via runRunner', async () => {
    const { fs, ps, clock } = makeDeps()
    const runner = codex({}, { fs, ps })
    const ctx = ctxFor('list and report')

    const cmd = await runner.buildCommand(ctx)
    const fixtureLines = loadFixtureLines('full-transcript.jsonl')
    ps.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const seenLines: TranscriptLine[] = []
    const onEvent = (evt: RunnerEvent): void => {
      for (const line of runner.toTranscriptLines(evt)) seenLines.push(line)
    }

    const resultPromise = runRunner(runner, ctx, { processService: ps, clock, onEvent })
    clock.advance(750)
    const result = await resultPromise

    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)

    // Suppressed events (thread.started, turn.started, item.started) leave no
    // lines. We expect: thinking, bash success, bash failure, assistant, done.
    expect(seenLines).toEqual([
      { kind: 'line', category: 'thinking', label: 'thinking', body: '' },
      { kind: 'line', category: 'tool-call', label: 'bash', body: '/bin/zsh -lc ls' },
      {
        kind: 'line',
        category: 'tool-error',
        label: 'bash',
        body: '/bin/zsh -lc false\n  exit 1',
      },
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'All done.' },
      {
        kind: 'block',
        heading: 'done',
        rows: [
          ['tokens', 'in: 250 · out: 42'],
          ['result', 'All done.'],
        ],
      },
    ])
  })
})
