import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { claude, isTerminalEvent, runRunner } from '../../../../src/runners/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { path } from '../../../../src/services/types.ts'

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path('/tmp/work'), env: {}, prompt, extraArgs: [] }
}

function loadFixtureLines(name: string): string[] {
  const filePath = resolve(import.meta.dir, '../../../fixtures/claude', name)
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

describe('ClaudeRunner mocked integration', () => {
  it('round-trips simple-success.jsonl through runRunner with correct events and terminal', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const runner = claude()
    const ctx = ctxFor('Reply with exactly: OK')

    const cmd = await runner.buildCommand(ctx)
    const fixtureLines = loadFixtureLines('simple-success.jsonl')
    fps.when(cmd.argv).respondWith({ stdout: fixtureLines, exit: 0 })

    const resultPromise = runRunner(runner, ctx, { processService: fps, clock })
    clock.advance(500)
    const result = await resultPromise

    // Terminal event is the turn-complete result envelope.
    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBe(500)

    // extractStructuredOutput returns the result text
    const output = runner.extractStructuredOutput(result.finalEvent)
    expect(output).toBe('OK')
  })

  it('round-trips error-max-turns.jsonl with terminal error and message present', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const runner = claude()
    const ctx = ctxFor('Do something complex')

    const cmd = await runner.buildCommand(ctx)
    const fixtureLines = loadFixtureLines('error-max-turns.jsonl')
    fps.when(cmd.argv).respondWith({ stdout: fixtureLines, exit: 1 })

    const result = await runRunner(runner, ctx, { processService: fps, clock })

    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('error')

    if (result.finalEvent.type === 'error') {
      expect(result.finalEvent.message).toBe('Max turns reached (5)')
      const data = result.finalEvent.data as Record<string, unknown>
      expect(data.subtype).toBe('error_max_turns')
    }

    expect(result.exitCode).toBe(1)
  })

  it('produces the correct argv shape for the spawned process', async () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514', maxTurns: 3 })
    const ctx = ctxFor('test prompt')

    const cmd = await runner.buildCommand(ctx)

    expect(cmd.argv[0]).toBe('claude')
    expect(cmd.argv).toContain('--bare')
    expect(cmd.argv).toContain('-p')
    expect(cmd.argv).toContain('test prompt')
    expect(cmd.argv).toContain('--output-format')
    expect(cmd.argv).toContain('stream-json')
    expect(cmd.argv).toContain('--verbose')
    expect(cmd.argv).toContain('--no-session-persistence')
    expect(cmd.argv).toContain('--model')
    expect(cmd.argv).toContain('claude-sonnet-4-20250514')
    expect(cmd.argv).toContain('--max-turns')
    expect(cmd.argv).toContain('3')
  })
})
