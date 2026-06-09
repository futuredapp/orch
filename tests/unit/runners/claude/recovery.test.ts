import { describe, expect, it } from 'bun:test'
import { claude } from '../../../../src/runners/claude/index.ts'
import { createCaptureLock } from '../../../../src/runners/codex/capture-lock.ts'
import type { ForkResumeContext, RunnerEvent } from '../../../../src/runners/types.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../../src/services/types.ts'

function assistant(payload: Record<string, unknown>): RunnerEvent {
  return { kind: 'info', type: 'assistant', payload }
}

function forkCtx(overrides: Partial<ForkResumeContext> = {}): ForkResumeContext {
  return {
    cwd: path('/tmp/work'),
    fs: new FakeFsService(),
    clock: new FakeClock(),
    lock: createCaptureLock(),
    env: {},
    extraArgs: [],
    ...overrides,
  }
}

describe('claude().isProgressEvent', () => {
  it('treats a genuine assistant event after resume as progress', () => {
    const runner = claude({})

    const result = runner.isProgressEvent?.(
      assistant({ message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }] } }),
      { sinceResume: true },
    )

    expect(result).toBe(true)
  })

  it('excludes the synthetic "API Error" assistant turn from progress (model "<synthetic>")', () => {
    const runner = claude({})

    const result = runner.isProgressEvent?.(
      assistant({
        message: { model: '<synthetic>' },
        error: 'rate_limit',
        isApiErrorMessage: true,
      }),
      { sinceResume: true },
    )

    expect(result).toBe(false)
  })

  it('ignores events seen before the resume nudge was issued', () => {
    const runner = claude({})

    const result = runner.isProgressEvent?.(assistant({ message: { model: 'claude-opus-4-8' } }), {
      sinceResume: false,
    })

    expect(result).toBe(false)
  })
})

describe('claude().forkResumeCommand', () => {
  it('emits --resume <checkpoint> --fork-session with the nudge as the -p prompt and no --session-id', async () => {
    const runner = claude({ model: 'claude-opus-4-8' })

    const cmd = await runner.forkResumeCommand?.(forkCtx(), 'parent-session-id', 'continue')

    expect(cmd).toBeDefined()
    const argv = cmd?.argv ?? []
    expect(argv).toContain('--fork-session')
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe('parent-session-id')
    expect(argv[argv.indexOf('-p') + 1]).toBe('continue')
    expect(argv).not.toContain('--session-id')
    expect(argv).toContain('stream-json')
  })

  it('threads through caller extraArgs and rejects denylisted flags', () => {
    const runner = claude({})

    expect(() =>
      runner.forkResumeCommand?.(forkCtx({ extraArgs: ['--settings', 'x'] }), 'sid', 'go'),
    ).toThrow(/denylist/)
  })
})
