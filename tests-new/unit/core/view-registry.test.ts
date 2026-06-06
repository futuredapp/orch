import { describe, expect, it } from 'bun:test'
import type { AgentStepConfig } from '../../../src/core/step.ts'
import { stepName } from '../../../src/core/types.ts'
import { ViewResolutionError } from '../../../src/core/view.ts'
import { resolveView } from '../../../src/core/view-registry.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'

function makeRunner(): FakeRunner {
  return new FakeRunner(new FakeProcessService())
}

function agentConfig(overrides: Partial<AgentStepConfig> = {}): AgentStepConfig {
  return { kind: 'agent', agent: makeRunner(), ...overrides }
}

describe('resolveView', () => {
  it('returns silent when stepConfig.silent is true, bypassing mode checks', () => {
    const resolution = resolveView({
      stepConfig: agentConfig({ silent: true }),
      runner: makeRunner(),
      runMode: 'plain',
      stepName: stepName('plan'),
      stepMode: 'autonomous',
    })

    expect(resolution).toEqual({ kind: 'silent' })
  })

  it('uses the step-level view override over the runner default', () => {
    const resolution = resolveView({
      stepConfig: agentConfig({ view: 'transcript', pane: 'left' }),
      runner: makeRunner(),
      runMode: 'two-pane',
      stepName: stepName('plan'),
      stepMode: 'autonomous',
    })

    expect(resolution).toEqual({ kind: 'attached', viewKind: 'transcript', pane: 'left' })
  })

  it('falls back to the runner defaultView when the step has no override', () => {
    // FakeRunner ships defaultView = { kind: 'transcript', pane: 'right' }
    const resolution = resolveView({
      stepConfig: agentConfig(),
      runner: makeRunner(),
      runMode: 'two-pane',
      stepName: stepName('plan'),
      stepMode: 'autonomous',
    })

    expect(resolution).toEqual({ kind: 'attached', viewKind: 'transcript', pane: 'right' })
  })

  it('falls back to the built-in default when the runner exposes no defaultView', () => {
    const bareRunner = { ...makeRunner(), defaultView: undefined } as unknown as FakeRunner
    const resolution = resolveView({
      stepConfig: agentConfig(),
      runner: bareRunner,
      runMode: 'two-pane',
      stepName: stepName('plan'),
      stepMode: 'autonomous',
    })

    expect(resolution).toEqual({ kind: 'attached', viewKind: 'transcript', pane: 'right' })
  })

  it('forces interactive view when stepMode is interactive, overriding the runner default', () => {
    const resolution = resolveView({
      stepConfig: agentConfig(),
      runner: makeRunner(),
      runMode: 'two-pane',
      stepName: stepName('brainstorm'),
      stepMode: 'interactive',
    })

    expect(resolution).toEqual({ kind: 'attached', viewKind: 'interactive', pane: 'right' })
  })

  it('throws ViewResolutionError for interactive view under --mode=plain', () => {
    let caught: unknown
    try {
      resolveView({
        stepConfig: agentConfig(),
        runner: makeRunner(),
        runMode: 'plain',
        stepName: stepName('brainstorm'),
        stepMode: 'interactive',
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ViewResolutionError)
    expect((caught as Error).message).toContain('use --mode=two-pane')
    expect((caught as Error).message).toContain('brainstorm')
  })

  it('honors a step-level pane override even when the runner picks right', () => {
    const resolution = resolveView({
      stepConfig: agentConfig({ pane: 'left' }),
      runner: makeRunner(),
      runMode: 'two-pane',
      stepName: stepName('plan'),
      stepMode: 'autonomous',
    })

    expect(resolution).toEqual({ kind: 'attached', viewKind: 'transcript', pane: 'left' })
  })

  it('passes silent first even when view/pane would otherwise resolve', () => {
    // `silent + view` is rejected at step.define parse time, but the resolver
    // is still defensive — downstream callers shouldn't reach the interactive
    // check if silent is set.
    const resolution = resolveView({
      stepConfig: { kind: 'agent', agent: makeRunner(), silent: true },
      runner: makeRunner(),
      runMode: 'plain',
      stepName: stepName('brainstorm'),
      stepMode: 'interactive',
    })

    expect(resolution).toEqual({ kind: 'silent' })
  })
})
