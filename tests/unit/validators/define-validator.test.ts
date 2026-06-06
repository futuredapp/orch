import { afterEach, describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { FakeFsService, FakeGitService, path } from '../../../src/services/index.ts'
import { __resetValidatorRegistryForTests } from '../../../src/validators/define-validator.ts'
import {
  DuplicateValidatorError,
  defineValidator,
  getValidator,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'

afterEach(() => {
  __resetValidatorRegistryForTests()
})

function makeCtx(value: unknown = undefined): {
  ctx: ValidatorCtx
  services: ValidatorServices
} {
  return {
    services: { fs: new FakeFsService(), git: new FakeGitService() },
    ctx: { stepName: stepName('plan'), cwd: path('/work'), value },
  }
}

describe('defineValidator', () => {
  it('returns a Validator with the given name directly (not a factory)', () => {
    const v = defineValidator('tests-passed', () => true)

    expect(v.name).toBe('tests-passed')
    expect(typeof v.run).toBe('function')
  })

  it('registers the validator under its name so getValidator can retrieve it', () => {
    const v = defineValidator('tests-passed', () => true)

    expect(getValidator('tests-passed')).toBe(v)
  })

  it('getValidator returns undefined for an unknown name', () => {
    expect(getValidator('not-registered')).toBeUndefined()
  })

  it('throws DuplicateValidatorError when the same name is registered twice', () => {
    defineValidator('tests-passed', () => true)

    expect(() => defineValidator('tests-passed', () => false)).toThrow(DuplicateValidatorError)
  })

  it('normalizes the return shape the same way check does', async () => {
    const { services, ctx } = makeCtx()
    const v = defineValidator('say-ok', () => 'nope')

    const result = await v.run(services, ctx)

    expect(result).toEqual({ ok: false, reason: 'nope' })
  })

  it('runs the registered function against ctx.value', async () => {
    const { services, ctx } = makeCtx({ count: 5 })
    const v = defineValidator('count-positive', (c) => {
      const val = c.value as { count: number }
      return val.count > 0
    })

    const result = await v.run(services, ctx)

    expect(result).toEqual({ ok: true })
  })

  it('registration is isolated across tests via __resetValidatorRegistryForTests', () => {
    // This test relies on the afterEach reset wired above. Registers the
    // same name that earlier tests in this file used; a missing reset would
    // surface as DuplicateValidatorError here.
    expect(() => defineValidator('tests-passed', () => true)).not.toThrow()
  })
})

describe('DuplicateValidatorError', () => {
  it('carries the validator name on the instance', () => {
    defineValidator('dup-me', () => true)

    try {
      defineValidator('dup-me', () => true)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateValidatorError)
      expect((err as DuplicateValidatorError).validatorName).toBe('dup-me')
    }
  })
})
