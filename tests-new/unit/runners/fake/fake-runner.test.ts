import { describe, expect, it } from 'bun:test'
import {
  FakeRunner,
  type InfoEvent,
  isTerminalEvent,
  type RunnerContext,
  type RunnerEvent,
} from '../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import { path } from '../../../../src/services/types.ts'

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path('/tmp'), env: {}, prompt, extraArgs: [] }
}

async function collectEvents(
  fr: FakeRunner,
  fps: FakeProcessService,
  ctx: RunnerContext,
): Promise<{ events: RunnerEvent[]; exitCode: number }> {
  const cmd = fr.buildCommand(ctx)
  const handle = fps.spawn({ argv: cmd.argv, env: cmd.env, cwd: ctx.cwd })
  const events: RunnerEvent[] = []

  for await (const line of handle.stdout) {
    const evt = fr.parseEvents(line)
    if (evt !== null) events.push(evt)
  }

  const { exitCode } = await handle.wait()
  return { events, exitCode }
}

describe('FakeRunner', () => {
  it('emits the configured info events followed by a turn-complete terminal event', async () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)
    const infoEvents: InfoEvent[] = [
      { kind: 'info', type: 'thinking', payload: { text: 'hmm' } },
      { kind: 'info', type: 'tool-call', payload: { name: 'read' } },
    ]
    fr.script({ events: infoEvents })

    const { events, exitCode } = await collectEvents(fr, fps, ctxFor('test'))

    expect(events).toHaveLength(3)
    expect(events[0]).toEqual(infoEvents[0])
    expect(events[1]).toEqual(infoEvents[1])
    expect(isTerminalEvent(events[2] as RunnerEvent)).toBe(true)
    expect((events[2] as RunnerEvent & { type: string }).type).toBe('turn-complete')
    expect(exitCode).toBe(0)
  })

  it('surfaces the scripted structured output via extractStructuredOutput', async () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)
    const output = { summary: 'done', score: 42 }
    fr.script({ structuredOutput: output })

    const { events } = await collectEvents(fr, fps, ctxFor('test'))

    const terminal = events.find((e) => isTerminalEvent(e))
    expect(terminal).toBeDefined()
    expect(
      fr.extractStructuredOutput(
        terminal as import('../../../../src/runners/index.ts').TerminalEvent,
      ),
    ).toEqual(output)
  })

  it('produces an error terminal event and a non-zero exit code when script sets failWith', async () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)
    fr.script({ failWith: { message: 'rate limited', exitCode: 2 } })

    const { events, exitCode } = await collectEvents(fr, fps, ctxFor('test'))

    const terminal = events.find((e) => isTerminalEvent(e))
    expect(terminal).toBeDefined()
    expect((terminal as RunnerEvent & { type: string }).type).toBe('error')
    expect((terminal as RunnerEvent & { message: string }).message).toBe('rate limited')
    expect(exitCode).toBe(2)
  })

  it('increments invocationCount each time buildCommand runs', () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)
    fr.script({ events: [] })
    fr.script({ events: [] })

    expect(fr.invocationCount).toBe(0)

    fr.buildCommand(ctxFor('first'))
    expect(fr.invocationCount).toBe(1)

    fr.buildCommand(ctxFor('second'))
    expect(fr.invocationCount).toBe(2)
  })

  it('consumes scripts in FIFO order across two independent runs', async () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)
    fr.script({ structuredOutput: 'first' })
    fr.script({ structuredOutput: 'second' })

    const run1 = await collectEvents(fr, fps, ctxFor('run1'))
    const run2 = await collectEvents(fr, fps, ctxFor('run2'))

    const term1 = run1.events.find((e) => isTerminalEvent(e))
    const term2 = run2.events.find((e) => isTerminalEvent(e))
    expect(
      fr.extractStructuredOutput(term1 as import('../../../../src/runners/index.ts').TerminalEvent),
    ).toBe('first')
    expect(
      fr.extractStructuredOutput(term2 as import('../../../../src/runners/index.ts').TerminalEvent),
    ).toBe('second')
  })

  it('throws when the script queue is empty', () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)

    expect(() => fr.buildCommand(ctxFor('oops'))).toThrow(/no script configured/)
  })

  it('exposes prepareAutoStop as a function by default', () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)

    expect(typeof fr.prepareAutoStop).toBe('function')
  })

  it('returns a no-op preparation (empty env, inert cleanup) from the default prepareAutoStop', async () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps)

    const prep = await fr.prepareAutoStop?.(ctxFor('go'))

    expect(prep?.env).toEqual({})
    await expect(prep?.cleanup()).resolves.toBeUndefined()
  })

  it('omits prepareAutoStop when constructed with supportsAutoStop:false', () => {
    const fps = new FakeProcessService()
    const fr = new FakeRunner(fps, { supportsAutoStop: false })

    expect(typeof fr.prepareAutoStop).toBe('undefined')
  })
})
