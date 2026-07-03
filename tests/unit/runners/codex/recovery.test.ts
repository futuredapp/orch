import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCaptureLock } from '../../../../src/runners/codex/capture-lock.ts'
import { codex } from '../../../../src/runners/codex/index.ts'
import type {
  ClassifyErrorSignal,
  ForkResumeContext,
  RunnerEvent,
  TerminalEvent,
} from '../../../../src/runners/types.ts'
import { FakeClock } from '../../../../src/services/clock/fake-clock.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { type Path, path } from '../../../../src/services/types.ts'

function turnFailed(message: string, extra: Record<string, unknown> = {}): TerminalEvent {
  return {
    kind: 'terminal',
    type: 'error',
    message,
    data: { type: 'turn.failed', error: { message, ...extra } },
  }
}

function signal(finalEvent: TerminalEvent, exitCode = 1): ClassifyErrorSignal {
  return { finalEvent, exitCode, infoEvents: [], stderr: '' }
}

function info(type: string): RunnerEvent {
  return { kind: 'info', type, payload: {} }
}

describe('codex().classifyError', () => {
  it('classifies exit-1 + turn.failed carrying server_is_overloaded as overload', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('stream error', { code: 'server_is_overloaded' })),
      'autonomous',
    )

    expect(classified?.category).toBe('overload')
    expect(classified?.transient).toBe(true)
  })

  it('maps an explicit "last status: 429" message to rate_limit (fail fast)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('exceeded retry limit, last status: 429 Too Many Requests')),
      'autonomous',
    )

    expect(classified?.category).toBe('rate_limit')
    expect(classified?.httpStatus).toBe(429)
    expect(classified?.transient).toBe(false)
  })

  it('classifies a "Usage limit reached" message as usage_limit', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('Usage limit reached')),
      'autonomous',
    )

    expect(classified?.category).toBe('usage_limit')
  })

  it('falls back to unknown/retryable for an unrecognized terminal message', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('something inscrutable')),
      'autonomous',
    )

    expect(classified?.category).toBe('unknown')
    expect(classified?.transient).toBe(true)
  })

  it('fails fast on a startup crash: no stdout events, fast non-zero exit, stderr only', () => {
    const runner = codex({})
    // The shape runRunner produces when the CLI dies before any stdout JSON:
    // a synthesized "no terminal event" error, no info events, and the real
    // reason captured on stderr.
    const startupCrash: ClassifyErrorSignal = {
      finalEvent: {
        kind: 'terminal',
        type: 'error',
        message:
          'runner "codex" produced no terminal event\nError loading rules:\n…default.rules:5: invalid decision: deny',
      },
      exitCode: 1,
      infoEvents: [],
      stderr: 'Error loading rules:\n…default.rules:5: invalid decision: deny',
    }

    const classified = runner.classifyError?.(startupCrash, 'autonomous')

    expect(classified?.category).toBe('launch')
    expect(classified?.transient).toBe(false)
  })

  it('does not flip a genuine transient turn.failed to launch just because nothing parsed', () => {
    const runner = codex({})
    // A real turn.failed reports on stdout (parsed terminal event, no stderr) —
    // the launch heuristic must not fire here.
    const classified = runner.classifyError?.(
      signal(turnFailed('something inscrutable')),
      'autonomous',
    )

    expect(classified?.category).toBe('unknown')
    expect(classified?.transient).toBe(true)
  })

  it('classifies an "unauthorized: invalid api key" turn.failed as auth (fail fast)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('unauthorized: invalid api key')),
      'autonomous',
    )

    expect(classified?.category).toBe('auth')
    expect(classified?.transient).toBe(false)
  })

  it('classifies a "not logged in" turn.failed as auth (fail fast)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('not logged in - run codex login')),
      'autonomous',
    )

    expect(classified?.category).toBe('auth')
    expect(classified?.transient).toBe(false)
  })

  it('classifies an "exceeded your quota" turn.failed as billing (fail fast)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('you have exceeded your quota')),
      'autonomous',
    )

    expect(classified?.category).toBe('billing')
    expect(classified?.transient).toBe(false)
  })

  it('classifies a "billing issue: payment required" turn.failed as billing (fail fast)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('billing issue: payment required')),
      'autonomous',
    )

    expect(classified?.category).toBe('billing')
    expect(classified?.transient).toBe(false)
  })

  it('does not classify a path containing "billing" as billing (word-boundary guard)', () => {
    const runner = codex({})

    const classified = runner.classifyError?.(
      signal(turnFailed('cannot read /home/user/billingReport.json')),
      'autonomous',
    )

    expect(classified?.category).not.toBe('billing')
  })
})

describe('codex().isProgressEvent', () => {
  it('treats item.completed after resume as progress', () => {
    const runner = codex({})

    expect(runner.isProgressEvent?.(info('item.completed'), { sinceResume: true })).toBe(true)
  })

  it('excludes item.started (the nudge-processing event) from progress', () => {
    const runner = codex({})

    expect(runner.isProgressEvent?.(info('item.started'), { sinceResume: true })).toBe(false)
  })

  it('ignores events seen before the resume nudge', () => {
    const runner = codex({})

    expect(runner.isProgressEvent?.(info('item.completed'), { sinceResume: false })).toBe(false)
  })
})

describe('codex().forkResumeCommand', () => {
  const FAKE_ROOT = '/fakehome/.codex/sessions'
  let prevRoot: string | undefined

  beforeEach(() => {
    prevRoot = process.env.ORCH_CODEX_SESSIONS_ROOT
    process.env.ORCH_CODEX_SESSIONS_ROOT = FAKE_ROOT
  })
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.ORCH_CODEX_SESSIONS_ROOT
    else process.env.ORCH_CODEX_SESSIONS_ROOT = prevRoot
  })

  async function ctxWith(
    fs: FakeFsService,
    extraArgs: readonly string[] = [],
  ): Promise<ForkResumeContext> {
    return {
      cwd: path('/work'),
      fs,
      clock: new FakeClock(),
      lock: createCaptureLock(),
      env: {},
      extraArgs,
    }
  }

  async function seedRollout(fs: FakeFsService, checkpoint: string): Promise<Path> {
    const dir = path(`${FAKE_ROOT}/2026/06/02`)
    await fs.mkdir(dir, { recursive: true })
    const file = path(`${dir}/rollout-2026-06-02T14-44-52-${checkpoint}.jsonl`)
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { id: checkpoint, cwd: '/work' } })}\n`,
    )
    return file
  }

  it('resumes a freshly forked id (not the checkpoint) when the rollout copy succeeds', async () => {
    const runner = codex({})
    const fs = new FakeFsService()
    await seedRollout(fs, 'checkpoint-abc')

    const cmd = await runner.forkResumeCommand?.(await ctxWith(fs), 'checkpoint-abc', 'continue')

    const argv = cmd?.argv ?? []
    expect(argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
    // Positional id + nudge sit after the `--` guard.
    const sep = argv.indexOf('--')
    const resumeId = argv[sep + 1]
    expect(resumeId).not.toBe('checkpoint-abc') // forked, not resumed in place
    expect(argv[sep + 2]).toBe('continue')
    expect(argv).toContain('--json')
  })

  it('degrades to resume-in-place against the checkpoint when no rollout is found', async () => {
    const runner = codex({})
    const fs = new FakeFsService() // no rollout seeded

    const cmd = await runner.forkResumeCommand?.(await ctxWith(fs), 'checkpoint-abc', 'continue')

    const argv = cmd?.argv ?? []
    const sep = argv.indexOf('--')
    expect(argv[sep + 1]).toBe('checkpoint-abc') // resume in place
    expect(argv[sep + 2]).toBe('continue')
  })
})
