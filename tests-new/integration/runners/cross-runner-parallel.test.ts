import { describe, expect, it } from 'bun:test'
import { parallel } from '../../../src/core/index.ts'
import { claude, codex, isTerminalEvent, runRunner } from '../../../src/runners/index.ts'
import type { RunnerContext } from '../../../src/runners/types.ts'
import { BunClock } from '../../../src/services/clock/index.ts'
import { BunFsService } from '../../../src/services/fs/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import { path } from '../../../src/services/types.ts'

const canRun =
  process.env.RUN_REAL_CLAUDE === '1' &&
  process.env.RUN_REAL_CODEX === '1' &&
  Bun.which('claude') !== null &&
  Bun.which('codex') !== null

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path(process.cwd()), env: {}, prompt, extraArgs: [] }
}

describe.skipIf(!canRun)('Cross-runner parallel: ClaudeRunner + CodexRunner', () => {
  it('runs both runners in parallel and both return turn-complete', async () => {
    const ps = new BunProcessService()
    const fs = new BunFsService()
    const clock = new BunClock()

    const claudeRunner = claude({ bare: false })
    const codexRunner = codex({}, { fs, ps })

    const claudeCtx = ctxFor('Reply with exactly: CLAUDE_OK')
    const codexCtx = ctxFor('Reply with exactly: CODEX_OK')

    const [claudeResult, codexResult] = await parallel([
      runRunner(claudeRunner, claudeCtx, { processService: ps, clock }),
      runRunner(codexRunner, codexCtx, { processService: ps, clock }),
    ])

    expect(isTerminalEvent(claudeResult.finalEvent)).toBe(true)
    expect(claudeResult.finalEvent.type).toBe('turn-complete')
    expect(claudeResult.exitCode).toBe(0)

    expect(isTerminalEvent(codexResult.finalEvent)).toBe(true)
    expect(codexResult.finalEvent.type).toBe('turn-complete')
    expect(codexResult.exitCode).toBe(0)
  }, 60_000)
})
