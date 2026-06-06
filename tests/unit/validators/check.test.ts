// MIGRATED → tests-new/unit/validators/check.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { FakeFsService, FakeGitService, path } from '../../../src/services/index.ts'
import {
  check,
  normalizeValidators,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'

function makeCtx(value: unknown = undefined): {
  ctx: ValidatorCtx
  services: ValidatorServices
} {
  return {
    services: { fs: new FakeFsService(), git: new FakeGitService() },
    ctx: { stepName: stepName('plan'), cwd: path('/work'), value },
  }
}

describe.skip('check return-shape normalization', () => {
  it('returns ok for a bare `true`', async () => {
    const { services, ctx } = makeCtx()
    const v = check(() => true)

    expect(await v.run(services, ctx)).toEqual({ ok: true })
  })

  it('returns a failure with a default reason for a bare `false`', async () => {
    const { services, ctx } = makeCtx()
    const v = check(() => false)

    expect(await v.run(services, ctx)).toEqual({ ok: false, reason: 'check returned false' })
  })

  it('returns a failure with the string as the reason', async () => {
    const { services, ctx } = makeCtx()
    const v = check(() => 'count was zero')

    expect(await v.run(services, ctx)).toEqual({ ok: false, reason: 'count was zero' })
  })

  it('passes through a full ValidatorResult', async () => {
    const { services, ctx } = makeCtx()
    const v = check(() => ({ ok: false, reason: 'explicit', hint: 'try again' }) as const)

    expect(await v.run(services, ctx)).toEqual({
      ok: false,
      reason: 'explicit',
      hint: 'try again',
    })
  })

  it('throws a programmer-error when the function returns undefined', async () => {
    const { services, ctx } = makeCtx()
    const v = check((() => undefined) as unknown as () => true)

    await expect(v.run(services, ctx)).rejects.toThrow('did you forget a return')
  })

  it('lets thrown exceptions bubble up (the executor catches them)', async () => {
    const { services, ctx } = makeCtx()
    const v = check(() => {
      throw new Error('boom')
    })

    await expect(v.run(services, ctx)).rejects.toThrow('boom')
  })

  it('receives ctx.value as its only positional argument', async () => {
    const { services, ctx } = makeCtx({ count: 42 })
    let seen: unknown
    const v = check((c) => {
      seen = c.value
      return true
    })

    await v.run(services, ctx)

    expect(seen).toEqual({ count: 42 })
  })

  it('is renamed to check@<stepName>#<index> when normalized by the executor helper', () => {
    const anon1 = check(() => true)
    const anon2 = check(() => true)

    const normalized = normalizeValidators([anon1, anon2], stepName('plan'))

    expect(normalized.map((v) => v.name)).toEqual(['check@plan#0', 'check@plan#1'])
  })

  it('a single-check shorthand still gets auto-renamed when wrapped into an array', () => {
    const anon = check(() => true)

    const normalized = normalizeValidators(anon, stepName('review'))

    expect(normalized.map((v) => v.name)).toEqual(['check@review#0'])
  })
})
