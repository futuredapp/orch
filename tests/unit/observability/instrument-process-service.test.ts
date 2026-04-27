// ---------------------------------------------------------------------------
// Unit tests — instrumentProcessService wrapper.
// ---------------------------------------------------------------------------
//
// Drives the wrapper through a stub SessionLogger to validate recording
// shape, tag-skip behaviour, and the "debug=false bypass" invariant.

import { describe, expect, it } from 'bun:test'
import { instrumentProcessService } from '../../../src/observability/instrument-process-service.ts'
import type {
  JsonObject,
  LogCategory,
  RawSink,
  SessionLogger,
  StepSpan,
} from '../../../src/observability/session-logger.ts'
import { stepSpanId } from '../../../src/observability/session-logger.ts'
import { FakeClock, FakeProcessService, path } from '../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../src/state/index.ts'

interface RecordingLogger extends SessionLogger {
  readonly records: ReadonlyArray<{ category: LogCategory; record: JsonObject }>
}

function makeRecordingLogger(debug: boolean): RecordingLogger {
  const records: Array<{ category: LogCategory; record: JsonObject }> = []
  const base: SessionLogger = {
    runId: runIdFactory('r-2026-04-24-abcdef'),
    debug,
    logsDir: null,
    async append(category: LogCategory, record: JsonObject): Promise<void> {
      records.push({ category, record })
    },
    forStep(name): StepSpan {
      return {
        stepSpanId: stepSpanId('stub-span'),
        stepName: name,
        async append(category, record) {
          records.push({ category, record })
        },
      }
    },
    async writeFile(): Promise<void> {
      /* no-op */
    },
    rawSink(): RawSink | null {
      return null
    },
    async close(): Promise<void> {
      /* no-op */
    },
  }
  return Object.assign(base, { records }) as RecordingLogger
}

describe('instrumentProcessService', () => {
  it('returns the base service unchanged when debug is false', () => {
    const base = new FakeProcessService()
    const logger = makeRecordingLogger(false)
    const clock = new FakeClock(0)

    const wrapped = instrumentProcessService(base, { logger, clock })

    expect(wrapped).toBe(base)
  })

  it('records non-agent spawn() calls to subprocesses.ndjson with argv, envKeys, and durationMs', async () => {
    const base = new FakeProcessService()
    const logger = makeRecordingLogger(true)
    const clock = new FakeClock(1_000)

    base.when(['git', 'status']).respondWith({ stdout: [], exitCode: 0 })

    const wrapped = instrumentProcessService(base, { logger, clock })
    const handle = wrapped.spawn({
      argv: ['git', 'status'],
      cwd: path('/tmp'),
      env: { PATH: '/usr/bin', HOME: '/root' },
    })
    // Drain stdout so the fake flips exited.
    for await (const _ of handle.stdout) {
      /* drain */
    }
    clock.set(1_050)
    await handle.wait()
    // Allow the fire-and-forget append to resolve.
    await Promise.resolve()

    const sub = logger.records.find((r) => r.category === 'subprocesses')
    expect(sub).toBeDefined()
    expect(sub?.record).toMatchObject({
      kind: 'spawn',
      argv: ['git', 'status'],
      envKeys: ['HOME', 'PATH'],
      cwd: '/tmp',
      exitCode: 0,
      durationMs: 50,
    })
  })

  it('skips spawns tagged as agent so they do not duplicate spawns.ndjson', async () => {
    const base = new FakeProcessService()
    const logger = makeRecordingLogger(true)
    const clock = new FakeClock(0)

    base.when(['claude']).respondWith({ stdout: [], exitCode: 0 })

    const wrapped = instrumentProcessService(base, { logger, clock })
    const handle = wrapped.spawn({
      argv: ['claude'],
      cwd: path('/tmp'),
      env: {},
      tag: 'agent',
    })
    for await (const _ of handle.stdout) {
      /* drain */
    }
    await handle.wait()
    await Promise.resolve()

    expect(logger.records.some((r) => r.category === 'subprocesses')).toBe(false)
  })

  it('records spawnForeground() calls with kind=spawnForeground', async () => {
    const base = new FakeProcessService()
    const logger = makeRecordingLogger(true)
    const clock = new FakeClock(0)

    base.whenForeground(['tmux', 'attach-session']).respondWith({ exitCode: 0 })

    const wrapped = instrumentProcessService(base, { logger, clock })
    const handle = wrapped.spawnForeground({
      argv: ['tmux', 'attach-session'],
      cwd: path('/tmp'),
      env: {},
    })
    await handle.wait()
    await Promise.resolve()

    const sub = logger.records.find((r) => r.category === 'subprocesses')
    expect(sub?.record.kind).toBe('spawnForeground')
    expect(sub?.record.argv).toEqual(['tmux', 'attach-session'])
  })
})
