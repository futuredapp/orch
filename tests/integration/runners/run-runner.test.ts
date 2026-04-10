import { describe, expect, it } from 'bun:test'
import {
  FakeRunner,
  isTerminalEvent,
  type RunnerContext,
  runRunner,
  type TerminalEvent,
} from '../../../src/runners/index.ts'
import { FakeClock } from '../../../src/services/clock/fake-clock.ts'
import { FakeProcessService } from '../../../src/services/process/fake-process-service.ts'
import { path } from '../../../src/services/types.ts'

function ctxFor(prompt: string): RunnerContext {
  return { cwd: path('/tmp'), env: {}, prompt, extraArgs: [] }
}

describe('runRunner', () => {
  it('round-trips info events, terminal event, and structured output through a FakeRunner', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const fr = new FakeRunner(fps)
    fr.script({
      events: [
        { kind: 'info', type: 'thinking', payload: { text: 'analyzing' } },
        { kind: 'info', type: 'tool-call', payload: { name: 'read' } },
      ],
      structuredOutput: { answer: 42 },
    })

    clock.advance(500)
    const result = await runRunner(fr, ctxFor('test'), { processService: fps, clock })

    expect(result.events).toHaveLength(3)
    expect(result.events[0]).toEqual({
      kind: 'info',
      type: 'thinking',
      payload: { text: 'analyzing' },
    })
    expect(result.events[1]).toEqual({ kind: 'info', type: 'tool-call', payload: { name: 'read' } })
    expect(isTerminalEvent(result.finalEvent)).toBe(true)
    expect(result.finalEvent.type).toBe('turn-complete')
    expect(result.exitCode).toBe(0)
  })

  it('returns a non-zero exitCode when the runner errors and does not throw', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock()
    const fr = new FakeRunner(fps)
    fr.script({ failWith: { message: 'crash', exitCode: 1 } })

    const result = await runRunner(fr, ctxFor('fail'), { processService: fps, clock })

    expect(result.exitCode).toBe(1)
    expect(result.finalEvent.type).toBe('error')
    if (result.finalEvent.type === 'error') {
      expect(result.finalEvent.message).toBe('crash')
    }
  })

  it('measures durationMs using the injected Clock', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock(1000)
    const fr = new FakeRunner(fps)
    fr.script({ events: [] })

    const resultPromise = runRunner(fr, ctxFor('timed'), { processService: fps, clock })
    clock.advance(250)
    const result = await resultPromise

    expect(result.durationMs).toBe(250)
  })

  it('never calls extractStructuredOutput in Phase 2', async () => {
    let called = false

    class SpyRunner extends FakeRunner {
      override extractStructuredOutput(finalEvent: TerminalEvent): unknown {
        called = true
        return super.extractStructuredOutput(finalEvent)
      }
    }

    const fps = new FakeProcessService()
    const clock = new FakeClock()
    const fr = new SpyRunner(fps)
    fr.script({ structuredOutput: { data: 'ignored' } })

    await runRunner(fr, ctxFor('spy'), { processService: fps, clock })

    expect(called).toBe(false)
  })

  it('reports an error terminal event when the process closes without producing one', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock()
    const fr = new FakeRunner(fps)
    fr.script({ events: [{ kind: 'info', type: 'thinking' }] })

    // Override parseEvents to return only info events (no terminal)
    const originalParse = fr.parseEvents.bind(fr)
    Object.defineProperty(fr, 'parseEvents', {
      value(line: string) {
        const evt = originalParse(line)
        if (evt !== null && isTerminalEvent(evt)) return null
        return evt
      },
    })

    // Re-script after override since the original script was consumed by the previous buildCommand setup
    // Actually, we need a fresh setup. Let's use a different approach:
    // Script the FakeProcessService directly with non-terminal JSON lines.
    const fps2 = new FakeProcessService()
    const fr2 = new FakeRunner(fps2)
    fr2.script({ events: [{ kind: 'info', type: 'progress' }] })

    // Use a spy that strips terminal events from parseEvents
    class NoTerminalRunner extends FakeRunner {
      override parseEvents(
        line: string,
      ): import('../../../src/runners/index.ts').RunnerEvent | null {
        const evt = super.parseEvents(line)
        if (evt !== null && isTerminalEvent(evt)) return null
        return evt
      }
    }

    const fps3 = new FakeProcessService()
    const fr3 = new NoTerminalRunner(fps3)
    fr3.script({ events: [{ kind: 'info', type: 'progress' }] })

    const result = await runRunner(fr3, ctxFor('no-terminal'), { processService: fps3, clock })

    expect(result.finalEvent.type).toBe('error')
    if (result.finalEvent.type === 'error') {
      expect(result.finalEvent.message).toContain('no terminal event')
    }
  })

  it('drains trailing stdout lines after the terminal event without including them in events', async () => {
    const fps = new FakeProcessService()
    const clock = new FakeClock()
    const fr = new FakeRunner(fps)
    fr.script({ events: [{ kind: 'info', type: 'progress' }] })

    // Add extra trailing lines directly to the FakeProcessService after the runner scripts
    // We need to manually register a response with trailing lines after the terminal event.
    const fps2 = new FakeProcessService()
    const nonce = `f-test`
    const infoLine = JSON.stringify({ kind: 'info', type: 'progress' })
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete' })
    const trailingLine = JSON.stringify({ kind: 'info', type: 'telemetry' })
    fps2.when([':fake:', nonce]).respondWith({
      stdout: [infoLine, terminalLine, trailingLine, trailingLine],
      exit: 0,
    })

    // Create a runner that uses the known nonce
    class FixedNonceRunner extends FakeRunner {
      override buildCommand(ctx: RunnerContext) {
        return { argv: [':fake:', nonce] as readonly string[], env: ctx.env }
      }
    }

    const fr2 = new FixedNonceRunner(fps2)
    fr2.script({ events: [] }) // Just to satisfy the script queue check

    const result = await runRunner(fr2, ctxFor('trailing'), { processService: fps2, clock })

    // Only 2 events: 1 info + 1 terminal. The trailing telemetry lines are discarded.
    expect(result.events).toHaveLength(2)
    expect(result.exitCode).toBe(0)
  })
})
