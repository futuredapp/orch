// MIGRATED → tests-new/unit/services/prompt/fake-prompt-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import type { StepName } from '../../../../src/core/types.ts'
import type { Host } from '../../../../src/hosts/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'

const ctx = (name: string): { stepName: StepName; host: Host } => ({
  stepName: name as StepName,
  host: {} as Host,
})

const SPEC = {
  question: 'continue?',
  fields: [{ name: 'notes' as const }],
  buttons: ['continue', 'retry'],
}

describe.skip('FakePromptService', () => {
  it('returns the scripted result for the configured step', async () => {
    const svc = new FakePromptService()
    svc.when('ask:continue').respondWith({
      cancelled: false,
      button: 'continue',
      fields: { notes: '' },
    })

    const result = await svc.ask(SPEC, ctx('ask:continue'))

    expect(result).toEqual({ cancelled: false, button: 'continue', fields: { notes: '' } })
  })

  it('throws with a "configure via .when()" message for an unscripted step', async () => {
    const svc = new FakePromptService()

    await expect(svc.ask(SPEC, ctx('ask:missing'))).rejects.toThrow(
      'Configure via .when("ask:missing").respondWith',
    )
  })

  it('records calls in arrival order', async () => {
    const svc = new FakePromptService()
    svc.when('ask:a').respondWith({ cancelled: true, fields: {} })
    svc.when('ask:b').respondWith({ cancelled: true, fields: {} })

    await svc.ask(SPEC, ctx('ask:a'))
    await svc.ask(SPEC, ctx('ask:b'))

    const calls = svc.recorded().map((c) => c.stepName as string)
    expect(calls).toEqual(['ask:a', 'ask:b'])
  })

  it('exposes the spec passed to each call', async () => {
    const svc = new FakePromptService()
    svc.when('ask:foo').respondWith({ cancelled: true, fields: {} })

    await svc.ask(SPEC, ctx('ask:foo'))

    const recorded = svc.recorded()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.spec.question).toBe('continue?')
    expect(recorded[0]?.spec.buttons).toEqual(['continue', 'retry'])
  })
})
