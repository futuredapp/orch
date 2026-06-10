import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_RECOVERY_INSTRUCTION,
  defaultInstructionResolver,
  resolveInstruction,
} from '../../../../src/core/recovery/instructions.ts'

describe('resolveInstruction', () => {
  it('resolves the built-in default for the retry kind when nothing is configured', () => {
    const instruction = resolveInstruction('retry')

    expect(instruction).toBe(DEFAULT_RECOVERY_INSTRUCTION)
    expect(instruction).toBe('continue')
  })

  it('resolves the built-in default for the continue kind when nothing is configured', () => {
    const instruction = resolveInstruction('continue')

    expect(instruction).toBe(DEFAULT_RECOVERY_INSTRUCTION)
  })

  it('lets a configured value override only the matching kind', () => {
    const configured = { retry: 'try that step again' }

    expect(resolveInstruction('retry', configured)).toBe('try that step again')
    expect(resolveInstruction('continue', configured)).toBe(DEFAULT_RECOVERY_INSTRUCTION)
  })

  it('lets retry and continue resolve to different configured strings', () => {
    const configured = { retry: 'retry the step', continue: 'pick up where you left off' }

    expect(resolveInstruction('retry', configured)).toBe('retry the step')
    expect(resolveInstruction('continue', configured)).toBe('pick up where you left off')
  })
})

describe('defaultInstructionResolver', () => {
  it('returns the built-in default for both kinds', () => {
    expect(defaultInstructionResolver('retry')).toBe(DEFAULT_RECOVERY_INSTRUCTION)
    expect(defaultInstructionResolver('continue')).toBe(DEFAULT_RECOVERY_INSTRUCTION)
  })
})
