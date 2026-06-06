// MIGRATED → tests-new/integration/runners/codex/codex-real.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { codex, isTerminalEvent, runRunner } from '../../../../src/runners/index.ts'
import type { RunnerContext } from '../../../../src/runners/types.ts'
import { BunClock } from '../../../../src/services/clock/index.ts'
import { BunFsService } from '../../../../src/services/fs/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import { path } from '../../../../src/services/types.ts'

const canRun = process.env.RUN_REAL_CODEX === '1' && Bun.which('codex') !== null

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path(process.cwd()), env: {}, prompt, extraArgs: [] }
}

describe.skip('CodexRunner real CLI', () => {
  it('runs "Reply with exactly: OK" and receives a turn-complete result', async () => {
    const ps = new BunProcessService()
    const fs = new BunFsService()
    const runner = codex({}, { fs, ps })
    const ctx = ctxFor('Reply with exactly: OK')
    const clock = new BunClock()

    const result = await runRunner(runner, ctx, { processService: ps, clock })

    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThan(0)
  }, 30_000)
})
