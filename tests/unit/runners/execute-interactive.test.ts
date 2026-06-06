import { describe, expect, it } from 'bun:test'
import { runInteractive } from '../../../src/runners/execute.ts'
import type { Runner, RunnerCommand, RunnerContext } from '../../../src/runners/types.ts'
import { defineRunner } from '../../../src/runners/types.ts'
import { FakeClock } from '../../../src/services/clock/fake-clock.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import { path } from '../../../src/services/types.ts'

function makeInteractiveRunner(): Runner {
  return defineRunner({
    name: 'test-interactive',
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext): RunnerCommand {
      return {
        argv: ['claude', '--session-id', 'test-session', '--', ctx.prompt],
        env: ctx.env,
      }
    },
    parseEvents() {
      return null
    },
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  })
}

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path('/workspace'), env: {}, prompt, extraArgs: [], mode: 'interactive' }
}

describe('runInteractive', () => {
  it('returns exit code 0 and elapsed duration on successful foreground process', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const runner = makeInteractiveRunner()
    const ctx = ctxFor('brainstorm auth')

    const cmd = await runner.buildCommand(ctx)
    fps.whenForeground(cmd.argv).respondWith({ exitCode: 0 })

    const resultPromise = runInteractive(runner, ctx, { processService: fps, clock })
    clock.advance(5000)
    const result = await resultPromise

    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBe(5000)
  })

  it('returns non-zero exit code when the foreground process fails', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const runner = makeInteractiveRunner()
    const ctx = ctxFor('brainstorm auth')

    const cmd = await runner.buildCommand(ctx)
    fps.whenForeground(cmd.argv).respondWith({ exitCode: 130 })

    const result = await runInteractive(runner, ctx, { processService: fps, clock })

    expect(result.exitCode).toBe(130)
  })
})
