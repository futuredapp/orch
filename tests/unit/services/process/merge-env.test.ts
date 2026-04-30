// The shared `mergeEnv` helper is the single source of truth for the
// passthrough contract used by every runner. The contract is tested ONCE
// here; per-runner tests stay focused on runner-specific extras
// (e.g. Claude's interactive `FORCE_COLOR=3`) and assume mergeEnv works.

import { describe, expect, it } from 'bun:test'
import { mergeEnv } from '../../../../src/services/process/merge-env.ts'

describe('mergeEnv passthrough', () => {
  it('passes arbitrary keys from processEnv through verbatim', () => {
    const env = mergeEnv(
      {
        LD_PRELOAD: '/lib/hook.so',
        NODE_OPTIONS: '--inspect',
        DATABASE_URL: 'postgres://x',
        STRIPE_SECRET_KEY: 'sk-stripe',
        OPENAI_BASE_URL: 'https://example.com',
        SECURITYSESSIONID: '0xabc',
      },
      {},
      {},
    )

    expect(env.LD_PRELOAD).toBe('/lib/hook.so')
    expect(env.NODE_OPTIONS).toBe('--inspect')
    expect(env.DATABASE_URL).toBe('postgres://x')
    expect(env.STRIPE_SECRET_KEY).toBe('sk-stripe')
    expect(env.OPENAI_BASE_URL).toBe('https://example.com')
    expect(env.SECURITYSESSIONID).toBe('0xabc')
  })

  it('filters undefined values from processEnv at the boundary', () => {
    const env = mergeEnv({ DEFINED: 'v', MISSING: undefined }, {}, {})

    expect(env.DEFINED).toBe('v')
    expect('MISSING' in env).toBe(false)
  })

  it('produces no undefined values in the result', () => {
    const env = mergeEnv({ A: 'a', B: undefined, C: 'c' }, { D: 'd' }, { E: 'e' })

    for (const v of Object.values(env)) {
      expect(v).not.toBeUndefined()
    }
  })

  it('returns an empty object when processEnv, extras, and ctxEnv are all empty', () => {
    expect(mergeEnv({}, {}, {})).toEqual({})
  })
})

describe('mergeEnv precedence', () => {
  it('lets extras override processEnv on conflict', () => {
    const env = mergeEnv({ FORCE_COLOR: '0' }, { FORCE_COLOR: '3' }, {})

    expect(env.FORCE_COLOR).toBe('3')
  })

  it('lets ctxEnv override extras on conflict', () => {
    const env = mergeEnv({}, { FORCE_COLOR: '3' }, { FORCE_COLOR: '0' })

    expect(env.FORCE_COLOR).toBe('0')
  })

  it('lets ctxEnv override processEnv on conflict', () => {
    const env = mergeEnv({ PATH: '/usr/bin' }, {}, { PATH: '/custom/bin' })

    expect(env.PATH).toBe('/custom/bin')
  })

  it('applies all three layers in order: processEnv < extras < ctxEnv', () => {
    const env = mergeEnv(
      { LAYER: 'processEnv', PROC_ONLY: 'p' },
      { LAYER: 'extras', EXTRAS_ONLY: 'e' },
      { LAYER: 'ctxEnv', CTX_ONLY: 'c' },
    )

    expect(env.LAYER).toBe('ctxEnv')
    expect(env.PROC_ONLY).toBe('p')
    expect(env.EXTRAS_ONLY).toBe('e')
    expect(env.CTX_ONLY).toBe('c')
  })
})
