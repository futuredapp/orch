import { describe, expect, it } from 'bun:test'
import type { AskStepConfig } from '../../../src/core/ask.ts'
import {
  AskNoDefaultError,
  AskParallelError,
  AutoStopUnsupportedError,
  StepNameCollisionError,
  SubworkflowDepthError,
} from '../../../src/core/errors.ts'
import { stepName } from '../../../src/core/types.ts'

describe('AskParallelError', () => {
  it('carries the step name and a hoist-above-or-fan-in remediation', () => {
    const err = new AskParallelError(stepName('ask:continue'))

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AskParallelError')
    expect(err.stepName as string).toBe('ask:continue')
    expect(err.message).toContain('Hoist the ask above')
    expect(err.message).not.toContain('--noninteractive')
  })
})

describe('AutoStopUnsupportedError', () => {
  it('names the step and runner and points at the supporting runners', () => {
    const err = new AutoStopUnsupportedError(stepName('brainstorm'), 'my-runner')

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AutoStopUnsupportedError')
    expect(err.stepName as string).toBe('brainstorm')
    expect(err.runnerName).toBe('my-runner')
    expect(err.message).toContain('brainstorm')
    expect(err.message).toContain('my-runner')
    expect(err.message).toContain('prepareAutoStop')
    expect(err.message).toContain('autoStop: true')
  })
})

describe('AskNoDefaultError', () => {
  it('synthesizes the suggested defaultWhenNoninteractive from the actual config', () => {
    const config: AskStepConfig = {
      kind: 'ask',
      question: 'continue?',
      fields: { notes: { placeholder: 'optional' } },
      buttons: ['continue', 'retry'],
    }

    const err = new AskNoDefaultError(stepName('ask:continue'), config)

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AskNoDefaultError')
    expect(err.message).toContain('ask:continue')
    expect(err.message).toContain("'continue'")
    expect(err.message).toContain("'retry'")
    expect(err.message).toContain("notes: ''")
    expect(err.message).toContain("'notes'")
  })

  it('omits the field hint when there are no fields', () => {
    const config: AskStepConfig = {
      kind: 'ask',
      question: 'q?',
      fields: {},
      buttons: ['ok'],
    }

    const err = new AskNoDefaultError(stepName('ask:q'), config)

    expect(err.message).toContain("'ok'")
    expect(err.message).not.toContain('field keys')
  })
})

describe('StepNameCollisionError', () => {
  it('includes the colliding step name and both sub-paths in its message', () => {
    const err = new StepNameCollisionError(
      stepName('plan'),
      ['simple-feature'],
      ['complex-feature'],
    )

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('StepNameCollisionError')
    expect(err.stepName as string).toBe('plan')
    expect(err.priorSubPath).toEqual(['simple-feature'])
    expect(err.attemptedSubPath).toEqual(['complex-feature'])
    expect(err.message).toContain('plan')
    expect(err.message).toContain('simple-feature')
    expect(err.message).toContain('complex-feature')
  })

  it('renders <root> when a sub-path is empty', () => {
    const err = new StepNameCollisionError(stepName('build'), [], ['some-sub'])

    expect(err.message).toContain('<root>')
    expect(err.message).toContain('some-sub')
  })

  it('emits the same-invocation hint when both sub-paths are equal', () => {
    const err = new StepNameCollisionError(stepName('plan'), ['simple-feature'], ['simple-feature'])

    expect(err.message).toContain('same workflow was invoked twice')
    expect(err.message).not.toContain('Two different sub-paths')
  })

  it('emits the different-scope hint when sub-paths differ', () => {
    const err = new StepNameCollisionError(stepName('plan'), ['a'], ['b'])

    expect(err.message).toContain('Two different sub-paths')
  })

  it('has a name that survives cross-realm instanceof via .name sentinel', () => {
    const err = new StepNameCollisionError(stepName('x'), [], [])

    expect(err.name).toBe('StepNameCollisionError')
  })
})

describe('SubworkflowDepthError', () => {
  it('includes the depth, max, and chain in its message', () => {
    const err = new SubworkflowDepthError(9, 8, ['a', 'b', 'c'])

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SubworkflowDepthError')
    expect(err.depth).toBe(9)
    expect(err.maxDepth).toBe(8)
    expect(err.subPath).toEqual(['a', 'b', 'c'])
    expect(err.message).toContain('9')
    expect(err.message).toContain('8')
    expect(err.message).toContain('a → b → c')
    expect(err.message).toContain('maxSubworkflowDepth')
  })

  it('renders <root> when the chain is empty', () => {
    const err = new SubworkflowDepthError(1, 0, [])

    expect(err.message).toContain('<root>')
  })

  it('has a name that survives cross-realm instanceof via .name sentinel', () => {
    const err = new SubworkflowDepthError(1, 0, [])

    expect(err.name).toBe('SubworkflowDepthError')
  })
})
