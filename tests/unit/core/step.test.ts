import { describe, expect, it } from 'bun:test'
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
})
