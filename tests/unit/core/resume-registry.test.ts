// MIGRATED → tests-new/unit/core/resume-registry.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { createResumeRegistry } from '../../../src/core/resume-registry.ts'
import { stepName } from '../../../src/core/types.ts'
import { FakeRunner, type Runner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

function makeRunner(name: string): Runner {
  const inner = new FakeRunner(new FakeProcessService())
  // FakeRunner.name is fixed; wrap it to override the diagnostic name without
  // touching the rest of the adapter surface.
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'name') return name
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as Runner
}

describe.skip('ResumeRegistry', () => {
  it('returns an empty registry from createResumeRegistry()', () => {
    const reg = createResumeRegistry()

    expect(reg.getRunnerForStep(stepName('any-step'))).toBeUndefined()
  })

  it('register then getRunnerForStep returns the registered runner', () => {
    const reg = createResumeRegistry()
    const runner = makeRunner('claude')

    reg.register(stepName('plan'), runner)

    expect(reg.getRunnerForStep(stepName('plan'))).toBe(runner)
  })

  it('returns undefined for a step never registered', () => {
    const reg = createResumeRegistry()
    reg.register(stepName('plan'), makeRunner('claude'))

    expect(reg.getRunnerForStep(stepName('never-registered'))).toBeUndefined()
  })

  it('keeps the most recent runner when registered twice for the same stepName (last-write-wins)', () => {
    const reg = createResumeRegistry()
    const first = makeRunner('claude')
    const second = makeRunner('claude-v2')

    reg.register(stepName('plan'), first)
    reg.register(stepName('plan'), second)

    expect(reg.getRunnerForStep(stepName('plan'))).toBe(second)
  })

  it('resolves two distinct same-named runner instances by their step names (F6 regression)', () => {
    const reg = createResumeRegistry()
    const claudeA = makeRunner('claude')
    const claudeB = makeRunner('claude')

    reg.register(stepName('design'), claudeA)
    reg.register(stepName('implement'), claudeB)

    expect(reg.getRunnerForStep(stepName('design'))).toBe(claudeA)
    expect(reg.getRunnerForStep(stepName('implement'))).toBe(claudeB)
    expect(claudeA).not.toBe(claudeB)
  })

  it('a workflow that registers steps A, B, C produces a registry where all three resolve', () => {
    const reg = createResumeRegistry()
    const a = makeRunner('claude')
    const b = makeRunner('codex')
    const c = makeRunner('claude')

    reg.register(stepName('a'), a)
    reg.register(stepName('b'), b)
    reg.register(stepName('c'), c)

    expect(reg.getRunnerForStep(stepName('a'))).toBe(a)
    expect(reg.getRunnerForStep(stepName('b'))).toBe(b)
    expect(reg.getRunnerForStep(stepName('c'))).toBe(c)
  })
})
