import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { schema } from '../../../src/core/schema.ts'
import { step } from '../../../src/core/step.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

function makeFakeRunner(): FakeRunner {
  return new FakeRunner(new FakeProcessService())
}

describe('step.define', () => {
  it('returns a frozen Step with the given name and config', () => {
    const agent = makeFakeRunner()
    const config = { agent, prompt: 'do the thing' }

    const s = step.define('plan', config)

    expect(s.name as string).toBe('plan')
    expect(s.config.kind).toBe('agent')
    expect(Object.isFrozen(s)).toBe(true)
  })

  it('produces config with kind agent', () => {
    const agent = makeFakeRunner()

    const s = step.define('plan', { agent, prompt: 'go' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.agent).toBe(agent)
      expect(s.config.prompt).toBe('go')
    }
  })

  it('validates the name as a StepName', () => {
    const agent = makeFakeRunner()

    const s = step.define('my-step-1', { agent })

    expect(s.name as string).toBe('my-step-1')
  })

  it('throws for an empty name', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('', { agent })).toThrow('must not be empty')
  })

  it('throws for a name with uppercase letters', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('MyStep', { agent })).toThrow('must match')
  })

  it('throws for a name with slashes', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('my/step', { agent })).toThrow('must match')
  })

  it('rejects names starting with the reserved commit: prefix', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('commit:foo', { agent })).toThrow('commit:')
  })

  it('defaults mode to undefined when not specified', () => {
    const agent = makeFakeRunner()

    const s = step.define('plan', { agent })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.mode).toBeUndefined()
    }
  })

  it('accepts mode interactive and produces a Step', () => {
    const agent = makeFakeRunner()

    const s = step.define('brainstorm', { agent, mode: 'interactive' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.mode).toBe('interactive')
    }
  })

  it('accepts mode autonomous explicitly', () => {
    const agent = makeFakeRunner()

    const s = step.define('work', { agent, mode: 'autonomous' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.mode).toBe('autonomous')
    }
  })

  it('throws at runtime when interactive mode is combined with returns', () => {
    const agent = makeFakeRunner()

    // Cast to bypass compile-time overload guard — testing the runtime belt-and-suspenders check
    const badConfig = {
      agent,
      mode: 'interactive' as const,
      returns: schema(z.object({ title: z.string() })),
    }

    expect(() => step.define('brainstorm', badConfig as never)).toThrow(
      'interactive steps cannot have "returns:"',
    )
  })
})
