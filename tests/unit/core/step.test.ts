import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { executionContext } from '../../../src/core/execution-context.ts'
import { backoffResume, noRetry } from '../../../src/core/recovery/index.ts'
import { schema } from '../../../src/core/schema.ts'
import { onCacheHit, type StepConfig, step } from '../../../src/core/step.ts'
import { type Path, path, stepName } from '../../../src/core/types.ts'
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

  it('rejects names starting with the reserved worktree: prefix', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('worktree:foo', { agent })).toThrow('worktree:')
  })

  it('rejects names starting with the reserved ask: prefix and points to ask()', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('ask:foo', { agent })).toThrow('ask()')
  })

  it.each([
    ['commit:', 'commit:foo'],
    ['worktree:', 'worktree:bar'],
    ['ask:', 'ask:baz'],
  ])('rejects reserved prefix %s (table-driven)', (prefix, name) => {
    const agent = makeFakeRunner()

    expect(() => step.define(name, { agent })).toThrow(prefix)
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

  it('carries autoStop:true on an interactive step config', () => {
    const agent = makeFakeRunner()

    const s = step.define('brainstorm', { agent, mode: 'interactive', autoStop: true })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.autoStop).toBe(true)
    }
  })

  it('leaves autoStop absent on an interactive step that does not set it', () => {
    const agent = makeFakeRunner()

    const s = step.define('brainstorm', { agent, mode: 'interactive' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.autoStop).toBeUndefined()
    }
  })

  it('throws at definition time when autoStop:true is set on an autonomous step', () => {
    const agent = makeFakeRunner()

    // Cast to bypass the interactive-only overload — exercising the runtime guard.
    const badConfig = { agent, mode: 'autonomous' as const, autoStop: true }

    expect(() => step.define('work', badConfig as never)).toThrow(
      'autoStop:true is only valid on interactive steps',
    )
  })

  it('carries a recovery strategy on an autonomous step config', () => {
    const agent = makeFakeRunner()

    const s = step.define('work', { agent, recovery: noRetry() })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.recovery?.kind).toBe('noRetry')
    }
  })

  it('carries a backoffResume override with its options on an autonomous step config', () => {
    const agent = makeFakeRunner()

    const s = step.define('work', { agent, recovery: backoffResume({ ceiling: 3 }) })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.recovery?.kind).toBe('backoffResume')
      expect(s.config.recovery?.options?.ceiling).toBe(3)
    }
  })

  it('leaves recovery absent on an autonomous step that does not set it', () => {
    const agent = makeFakeRunner()

    const s = step.define('work', { agent })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.recovery).toBeUndefined()
    }
  })

  it('throws at definition time when recovery is set on an interactive step', () => {
    const agent = makeFakeRunner()

    // Cast to bypass the autonomous-only typing — exercising the runtime guard.
    const badConfig = { agent, mode: 'interactive' as const, recovery: noRetry() }

    expect(() => step.define('brainstorm', badConfig as never)).toThrow(
      'recovery is only valid on autonomous agent steps',
    )
  })

  it('accepts a step-level view override of transcript', () => {
    const agent = makeFakeRunner()

    const s = step.define('plan', { agent, view: 'transcript' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.view).toBe('transcript')
    }
  })

  it('accepts a step-level pane override of left', () => {
    const agent = makeFakeRunner()

    const s = step.define('plan', { agent, pane: 'left' })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.pane).toBe('left')
    }
  })

  it('accepts silent:true on an otherwise-default step', () => {
    const agent = makeFakeRunner()

    const s = step.define('refresh', { agent, silent: true })

    expect(s.config.kind).toBe('agent')
    if (s.config.kind === 'agent') {
      expect(s.config.silent).toBe(true)
    }
  })

  it('rejects silent:true combined with view', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('bad', { agent, silent: true, view: 'transcript' } as never)).toThrow(
      'mutually exclusive',
    )
  })

  it('rejects silent:true combined with pane', () => {
    const agent = makeFakeRunner()

    expect(() => step.define('bad', { agent, silent: true, pane: 'left' } as never)).toThrow(
      'mutually exclusive',
    )
  })

  it('rejects an unknown view kind and lists the accepted values', () => {
    const agent = makeFakeRunner()

    let caught: unknown
    try {
      step.define('bad', { agent, view: 'approval' as unknown as 'transcript' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('unknown view "approval"')
    expect((caught as Error).message).toContain('interactive')
    expect((caught as Error).message).toContain('transcript')
  })
})

describe('onCacheHit — kind-agnostic dispatch', () => {
  it('agent kind without returns is a no-op', () => {
    const agent = makeFakeRunner()
    const config: StepConfig = { kind: 'agent', agent }

    expect(() => onCacheHit(config, stepName('plan'), { whatever: 1 })).not.toThrow()
  })

  it('agent kind with returns re-validates the cached value against the schema', () => {
    const agent = makeFakeRunner()
    const config: StepConfig = {
      kind: 'agent',
      agent,
      returns: schema(z.object({ count: z.number() })),
    }

    expect(() => onCacheHit(config, stepName('plan'), { count: 'not-a-number' })).toThrow()
    expect(() => onCacheHit(config, stepName('plan'), { count: 7 })).not.toThrow()
  })

  it('commit kind is a no-op regardless of cached value', () => {
    const config: StepConfig = { kind: 'commit', message: 'after research' }

    expect(() => onCacheHit(config, stepName('commit:after-research'), null)).not.toThrow()
    expect(() =>
      onCacheHit(config, stepName('commit:after-research'), { sha: 'abc' }),
    ).not.toThrow()
  })

  it('ask kind is a no-op on cache replay (validity is checked separately)', () => {
    const config: StepConfig = {
      kind: 'ask',
      question: 'q?',
      fields: {},
      buttons: ['ok'],
    }

    expect(() =>
      onCacheHit(config, stepName('ask:q'), { cancelled: true, fields: {} }),
    ).not.toThrow()
    expect(() =>
      onCacheHit(config, stepName('ask:q'), { cancelled: false, button: 'ok', fields: {} }),
    ).not.toThrow()
  })

  it('worktree kind with enter:true reapplies setWorkflowCwd from cached path', async () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: true,
    }
    const cachedValue = {
      path: path('/tmp/foo--feat-foo'),
      branch: 'feat/foo',
      fromRef: 'HEAD',
    }

    let observed: Path | undefined
    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, () => {
      onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)
      observed = executionContext.getStore()?.workflowCwd
    })

    expect(observed).toBe(path('/tmp/foo--feat-foo'))
  })

  it('worktree kind with enter:false leaves workflowCwd untouched', async () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: false,
    }
    const cachedValue = {
      path: path('/tmp/foo--feat-foo'),
      branch: 'feat/foo',
      fromRef: 'HEAD',
    }

    let observed: Path | undefined
    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, () => {
      onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)
      observed = executionContext.getStore()?.workflowCwd
    })

    expect(observed).toBeUndefined()
  })

  it('throws when cached worktree value is missing path', () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: true,
    }
    const cachedValue = { branch: 'feat/foo', fromRef: 'HEAD' }

    expect(() => onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)).toThrow(
      /malformed/,
    )
  })

  it('throws when cached worktree value has a non-string branch', () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: true,
    }
    const cachedValue = { path: '/x', branch: 123, fromRef: 'HEAD' }

    expect(() => onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)).toThrow(
      /malformed/,
    )
  })

  it('throws when cached branch differs from the current config (slug collision)', () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: false,
    }
    const cachedValue = {
      path: path('/tmp/proj--feat-foo'),
      branch: 'feat/Foo',
      fromRef: 'HEAD',
    }

    let caught: unknown
    try {
      onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('feat/foo')
    expect((caught as Error).message).toContain('feat/Foo')
  })

  it('throws when cached fromRef differs from the current config', () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: false,
      fromRef: 'main',
    }
    const cachedValue = {
      path: path('/tmp/proj--feat-foo'),
      branch: 'feat/foo',
      fromRef: 'HEAD',
    }

    let caught: unknown
    try {
      onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('main')
    expect((caught as Error).message).toContain('HEAD')
  })

  it('accepts an exact-match cache hit (resume case)', async () => {
    const config: StepConfig = {
      kind: 'worktree',
      branch: 'feat/foo',
      enter: true,
      fromRef: 'main',
    }
    const cachedValue = {
      path: path('/tmp/foo--feat-foo'),
      branch: 'feat/foo',
      fromRef: 'main',
    }

    let observed: Path | undefined
    await executionContext.run({ parallelDepth: 0, workflowCwd: undefined }, () => {
      expect(() => onCacheHit(config, stepName('worktree:feat-foo'), cachedValue)).not.toThrow()
      observed = executionContext.getStore()?.workflowCwd
    })

    expect(observed).toBe(path('/tmp/foo--feat-foo'))
  })
})
