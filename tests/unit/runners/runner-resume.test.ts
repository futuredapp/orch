import { describe, expect, it } from 'bun:test'
import { claude } from '../../../src/runners/claude/index.ts'
import { createCaptureLock } from '../../../src/runners/codex/capture-lock.ts'
import { codex } from '../../../src/runners/codex/index.ts'
import { FakeRunner } from '../../../src/runners/fake/index.ts'
import type { CaptureSessionIdContext, Runner, RunnerContext } from '../../../src/runners/types.ts'
import { FakeClock } from '../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../src/services/fs/fake-fs-service.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import { path } from '../../../src/services/types.ts'

function ctxFor(overrides?: Partial<RunnerContext>): RunnerContext {
  return {
    cwd: path('/tmp/work'),
    env: {},
    prompt: '',
    extraArgs: [],
    mode: 'interactive',
    ...overrides,
  }
}

// Smart accessor: every test in this file works against runners we just
// configured to expose `resumeCommand`. Keeping the assertion local lets us
// satisfy CLAUDE.md rule #6 (no `!`) without scattering safeguards.
function resumeOf(runner: Runner): NonNullable<Runner['resumeCommand']> {
  if (typeof runner.resumeCommand !== 'function') {
    throw new Error(`runner "${runner.name}" did not expose resumeCommand`)
  }
  return runner.resumeCommand
}

describe('claude().resumeCommand', () => {
  it('returns argv that resumes the named session via claude --resume', async () => {
    const runner = claude()

    const cmd = await resumeOf(runner)(ctxFor(), 'sess-abc-123')

    expect(cmd.argv).toEqual(['claude', '--resume', 'sess-abc-123'])
  })

  it('threads --model and configured flags into the resume argv', async () => {
    const runner = claude({ model: 'claude-sonnet-4-20250514', flags: ['--allowedTools', 'Read'] })

    const cmd = await resumeOf(runner)(ctxFor(), 'sess-xyz')

    expect(cmd.argv).toEqual([
      'claude',
      '--resume',
      'sess-xyz',
      '--model',
      'claude-sonnet-4-20250514',
      '--allowedTools',
      'Read',
    ])
  })

  it('forwards FORCE_COLOR=3 in the resume env so Ink renders truecolor in tmux', async () => {
    const runner = claude()

    const cmd = await resumeOf(runner)(ctxFor(), 'sess-1')

    expect(cmd.env.FORCE_COLOR).toBe('3')
  })
})

describe('codex().resumeCommand', () => {
  it('returns argv that resumes the named thread via codex resume', async () => {
    const runner = codex({}, { fs: new FakeFsService(), ps: new FakeProcessService() })

    const cmd = await resumeOf(runner)(ctxFor(), 'thread-001')

    expect(cmd.argv).toEqual(['codex', 'resume', 'thread-001'])
  })

  it('threads configured flags into the resume argv', async () => {
    const runner = codex(
      { flags: ['--ask-for-approval', 'never'] },
      { fs: new FakeFsService(), ps: new FakeProcessService() },
    )

    const cmd = await resumeOf(runner)(ctxFor(), 'thread-7')

    expect(cmd.argv).toEqual(['codex', 'resume', 'thread-7', '--ask-for-approval', 'never'])
  })
})

describe('FakeRunner.resumeCommand', () => {
  it('is undefined until withResumeCommand is called', () => {
    const runner = new FakeRunner(new FakeProcessService())

    expect(runner.resumeCommand).toBeUndefined()
  })

  it('returns the configured argv shape after withResumeCommand()', async () => {
    const runner = new FakeRunner(new FakeProcessService()).withResumeCommand()

    const cmd = await resumeOf(runner)(ctxFor(), 'sid-1')

    expect(cmd.argv[0]).toBe(':fake-resume:')
    expect(cmd.argv[cmd.argv.length - 1]).toBe('sid-1')
  })
})

function captureCtxFor(): CaptureSessionIdContext {
  return {
    cwd: path('/tmp/work'),
    fs: new FakeFsService(),
    clock: new FakeClock(0),
    lock: createCaptureLock(),
  }
}

describe('FakeRunner.captureSessionId', () => {
  it('is undefined until withCaptureSessionId is called (mirrors a runner with no capture primitive)', () => {
    const runner = new FakeRunner(new FakeProcessService())

    expect(runner.captureSessionId).toBeUndefined()
  })

  it('resolves snapshotReady and result with a synthetic sessionId after withCaptureSessionId() default', async () => {
    const runner = new FakeRunner(new FakeProcessService()).withCaptureSessionId()
    const captureFn = runner.captureSessionId
    if (typeof captureFn !== 'function') {
      throw new Error('captureSessionId did not become callable after withCaptureSessionId()')
    }

    const handle = captureFn(captureCtxFor())
    await handle.snapshotReady
    const outcome = await handle.result

    expect(outcome).toMatchObject({ sessionId: expect.stringMatching(/^fake-session-/) })
  })

  it('uses a caller-supplied implementation when provided', async () => {
    const runner = new FakeRunner(new FakeProcessService()).withCaptureSessionId(() => ({
      snapshotReady: Promise.resolve(),
      result: Promise.resolve({ error: 'ambiguous' as const }),
    }))
    const captureFn = runner.captureSessionId
    if (typeof captureFn !== 'function') {
      throw new Error('captureSessionId did not become callable after withCaptureSessionId(impl)')
    }

    const handle = captureFn(captureCtxFor())
    expect(await handle.result).toEqual({ error: 'ambiguous' })
  })
})
