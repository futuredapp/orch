import { describe, expect, it } from 'bun:test'
import {
  envKeys,
  isSecretKey,
  redactEnvValues,
  redactReproduceCommand,
} from '../../../src/observability/redact.ts'

describe('isSecretKey', () => {
  it('flags ANTHROPIC-prefixed env keys as secret', () => {
    expect(isSecretKey('ANTHROPIC_API_KEY')).toBe(true)
    expect(isSecretKey('ANTHROPIC_BASE_URL')).toBe(true)
  })

  it('flags CLAUDE-prefixed env keys as secret', () => {
    expect(isSecretKey('CLAUDE_CODE_TOKEN')).toBe(true)
    expect(isSecretKey('CLAUDE_PROJECT_ID')).toBe(true)
  })

  it('flags keys ending with _TOKEN, _SECRET, _KEY, or _PASSWORD as secret', () => {
    expect(isSecretKey('GITHUB_TOKEN')).toBe(true)
    expect(isSecretKey('STRIPE_SECRET')).toBe(true)
    expect(isSecretKey('AWS_SECRET_KEY')).toBe(true)
    expect(isSecretKey('DB_PASSWORD')).toBe(true)
  })

  it('passes through benign env keys untouched', () => {
    expect(isSecretKey('PATH')).toBe(false)
    expect(isSecretKey('HOME')).toBe(false)
    expect(isSecretKey('USER')).toBe(false)
    expect(isSecretKey('NODE_ENV')).toBe(false)
  })
})

describe('envKeys', () => {
  it('returns a sorted list of env keys with no values', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/me', NODE_ENV: 'test' }
    expect(envKeys(env)).toEqual(['HOME', 'NODE_ENV', 'PATH'])
  })

  it('returns an empty list for an empty env', () => {
    expect(envKeys({})).toEqual([])
  })
})

describe('redactEnvValues', () => {
  it('drops ANTHROPIC_API_KEY value', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-xxx', PATH: '/usr/bin' }
    expect(redactEnvValues(env)).toEqual({ ANTHROPIC_API_KEY: '***', PATH: '/usr/bin' })
  })

  it('drops *_TOKEN / *_SECRET / *_KEY / *_PASSWORD values', () => {
    const env = {
      GITHUB_TOKEN: 'ghp_xxx',
      STRIPE_SECRET: 'sk_live_xxx',
      AWS_ACCESS_KEY: 'AKIA...',
      DB_PASSWORD: 'hunter2',
      HOME: '/home/me',
    }
    expect(redactEnvValues(env)).toEqual({
      AWS_ACCESS_KEY: '***',
      DB_PASSWORD: '***',
      GITHUB_TOKEN: '***',
      HOME: '/home/me',
      STRIPE_SECRET: '***',
    })
  })

  it('passes through benign env vars untouched', () => {
    const env = { PATH: '/usr/bin', NODE_ENV: 'test' }
    expect(redactEnvValues(env)).toEqual({ NODE_ENV: 'test', PATH: '/usr/bin' })
  })

  it('skips undefined values', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin', UNSET: undefined }
    expect(redactEnvValues(env)).toEqual({ PATH: '/usr/bin' })
  })
})

describe('redactReproduceCommand', () => {
  it('redacts values inside reproduce commands', () => {
    const cmd = 'ANTHROPIC_API_KEY=sk-ant-xxx PATH=/usr/bin claude -p "hi"'
    expect(redactReproduceCommand(cmd)).toBe('ANTHROPIC_API_KEY=*** PATH=/usr/bin claude -p "hi"')
  })

  it('leaves benign KEY=value pairs untouched', () => {
    const cmd = 'NODE_ENV=test PATH=/usr/bin echo hi'
    expect(redactReproduceCommand(cmd)).toBe(cmd)
  })
})
