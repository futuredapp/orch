import { describe, expect, it } from 'bun:test'
import { claude, isTerminalEvent, runRunner } from '../../../../src/runners/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { BunClock } from '../../../../src/services/clock/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import { path } from '../../../../src/services/types.ts'

const canRun = process.env.RUN_REAL_CLAUDE === '1' && Bun.which('claude') !== null

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path(process.cwd()), env: {}, prompt, extraArgs: [] }
}

describe.skipIf(!canRun)('ClaudeRunner real CLI', () => {
  it('runs "Reply with exactly: OK" and receives a success result with intermediate events', async () => {
    const runner = claude({ maxTurns: 1 })
    const ctx = ctxFor('Reply with exactly: OK')
    const processService = new BunProcessService()
    const clock = new BunClock()

    const result = await runRunner(runner, ctx, { processService, clock })

    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('turn-complete')

    if (result.finalEvent.type === 'turn-complete') {
      const data = result.finalEvent.data as Record<string, unknown>
      expect(data.subtype).toBe('success')
    }

    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThan(0)
  }, 30_000)
})
