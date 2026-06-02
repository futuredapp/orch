import { describe, expect, it } from 'bun:test'
import {
  defineRunner,
  type Runner,
  type RunnerContext,
  type RunnerEvent,
  runRunner,
} from '../../../src/runners/index.ts'
import { FakeClock, path } from '../../../src/services/index.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import type {
  ProcessService,
  SpawnHandle,
  SpawnOptions,
} from '../../../src/services/process/index.ts'

// ---------------------------------------------------------------------------
// Local ProcessService stub that yields a controllable stdout iterator.
// Uses the public ProcessService port — no mock.module, no vi.mock.
// ---------------------------------------------------------------------------

interface Killable {
  killed: boolean
}

function makeHandle(stdout: AsyncIterable<string>): SpawnHandle & Killable {
  const emptyStderr: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        return { value: undefined, done: true }
      },
    }),
  }
  const state: Killable = { killed: false }
  return {
    stdout,
    stderr: emptyStderr,
    async wait() {
      return { exitCode: 0 }
    },
    kill() {
      state.killed = true
    },
    get killed() {
      return state.killed
    },
  }
}

class StubProcessService implements ProcessService {
  #handle: (SpawnHandle & Killable) | null = null

  setNext(handle: SpawnHandle & Killable): void {
    this.#handle = handle
  }

  spawn(_opts: SpawnOptions): SpawnHandle {
    if (this.#handle === null) throw new Error('StubProcessService: no handle configured')
    const h = this.#handle
    this.#handle = null
    return h
  }

  spawnForeground(): import('../../../src/services/process/process-service.ts').ForegroundHandle {
    throw new Error('StubProcessService: spawnForeground not implemented')
  }
}

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path('/tmp'), env: {}, prompt, extraArgs: [] }
}

function dummyRunner(parseEvents: (line: string) => RunnerEvent | null): Runner {
  return defineRunner({
    name: 'dummy',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [':dummy:'], env: ctx.env }
    },
    parseEvents,
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  })
}

function oneLineStdout(line: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => {
      let emitted = false
      return {
        async next() {
          if (!emitted) {
            emitted = true
            return { value: line, done: false }
          }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

function rejectingStdout(message: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<string>> {
        throw new Error(message)
      },
    }),
  }
}

describe('runRunner cleanup on failure paths', () => {
  it('runRunner kills the subprocess when parseEvents throws mid-stream', async () => {
    const handle = makeHandle(oneLineStdout('line-1'))
    const ps = new StubProcessService()
    ps.setNext(handle)

    const runner = dummyRunner(() => {
      throw new Error('parseEvents exploded')
    })

    let caught: unknown
    try {
      await runRunner(runner, ctxFor('x'), { processService: ps, clock: new FakeClock() })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('parseEvents exploded')
    expect(handle.killed).toBe(true)
  })

  it('runRunner kills the subprocess when the stdout iterator rejects', async () => {
    const handle = makeHandle(rejectingStdout('stdout pipe broke'))
    const ps = new StubProcessService()
    ps.setNext(handle)

    const runner = dummyRunner(() => null)

    let caught: unknown
    try {
      await runRunner(runner, ctxFor('x'), { processService: ps, clock: new FakeClock() })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('stdout pipe broke')
    expect(handle.killed).toBe(true)
  })
})

describe('runRunner recovery seams (U7)', () => {
  it('uses the prebuilt command override instead of buildCommand', async () => {
    const fps = new FakeProcessService()
    fps.when([':forked:']).respondWith({
      stdout: [JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })],
      exitCode: 0,
    })
    const runner = dummyRunner((line) => JSON.parse(line) as RunnerEvent)

    const result = await runRunner(runner, ctxFor('x'), {
      processService: fps,
      clock: new FakeClock(),
      command: { argv: [':forked:'], env: {} },
    })

    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)
  })

  it('aborts a hung spawn via the signal and synthesizes a terminal error', async () => {
    const fps = new FakeProcessService()
    // One info line, then stdout hangs open until the handle is killed.
    fps.when([':hang:']).respondWith({
      stdout: [JSON.stringify({ kind: 'info', type: 'assistant' })],
      exitCode: 0,
      stallUntilKilled: true,
    })
    const runner = dummyRunner((line) => JSON.parse(line) as RunnerEvent)
    const controller = new AbortController()

    const promise = runRunner(runner, ctxFor('x'), {
      processService: fps,
      clock: new FakeClock(),
      command: { argv: [':hang:'], env: {} },
      signal: controller.signal,
    })
    // Let the runner drain the one info line and wedge on the next read.
    await new Promise((r) => setImmediate(r))
    controller.abort()

    const result = await promise
    expect(result.finalEvent.type).toBe('error')
    expect(result.exitCode).toBe(-1)
  })
})

describe('runRunner onEvent hook (phase 13c observe mode)', () => {
  it('forwards every parsed RunnerEvent to the onEvent callback in order', async () => {
    const lines = ['info-1', 'info-2', 'terminal']
    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next(): Promise<IteratorResult<string>> {
            if (i < lines.length) {
              const value = lines[i++] ?? ''
              return { value, done: false }
            }
            return { value: undefined, done: true }
          },
        }
      },
    }

    const handle = makeHandle(stdout)
    const ps = new StubProcessService()
    ps.setNext(handle)

    const runner = dummyRunner((line): RunnerEvent | null => {
      if (line === 'terminal') return { kind: 'terminal', type: 'turn-complete' }
      return { kind: 'info', type: line }
    })

    const observed: RunnerEvent[] = []
    await runRunner(runner, ctxFor('x'), {
      processService: ps,
      clock: new FakeClock(),
      onEvent: (e) => observed.push(e),
    })

    expect(observed.map((e) => (e.kind === 'info' ? e.type : `T:${e.type}`))).toEqual([
      'info-1',
      'info-2',
      'T:turn-complete',
    ])
  })
})
