import { describe, expect, it } from 'bun:test'
import {
  ConfigLoadError,
  defineConfig,
  type OrchestratorConfig,
  resolveWorkflow,
} from '../../../src/config/index.ts'
import { path } from '../../../src/services/index.ts'

describe('defineConfig', () => {
  it('returns the config unchanged as a typed identity function', () => {
    const input = { workflows: { deploy: './workflows/deploy.ts' } }

    const result = defineConfig(input)

    expect(result).toEqual(input)
  })
})

describe('resolveWorkflow', () => {
  const config: OrchestratorConfig = {
    workflows: {
      deploy: './workflows/deploy.ts',
      migrate: 'workflows/migrate.ts',
      absolute: '/opt/workflows/abs.ts',
    },
  }
  const cwd = path('/project')

  it('resolves a relative workflow path against cwd', () => {
    const result = resolveWorkflow(config, 'deploy', cwd)

    expect(result).toBe(path('/project/./workflows/deploy.ts'))
  })

  it('resolves a relative path without dot prefix against cwd', () => {
    const result = resolveWorkflow(config, 'migrate', cwd)

    expect(result).toBe(path('/project/workflows/migrate.ts'))
  })

  it('keeps an absolute path as-is', () => {
    const result = resolveWorkflow(config, 'absolute', cwd)

    expect(result).toBe(path('/opt/workflows/abs.ts'))
  })

  it('throws on an unknown workflow name', () => {
    expect(() => resolveWorkflow(config, 'nope', cwd)).toThrow('Unknown workflow "nope"')
  })

  it('lists available workflows in the error message', () => {
    try {
      resolveWorkflow(config, 'nope', cwd)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('deploy')
      expect((err as Error).message).toContain('migrate')
    }
  })

  it('rejects a workflow path containing ".." traversal', () => {
    const evil: OrchestratorConfig = {
      workflows: { hack: '../../../etc/passwd' },
    }

    expect(() => resolveWorkflow(evil, 'hack', cwd)).toThrow('..')
  })

  it('shows (none) when config has an empty workflow map', () => {
    const empty: OrchestratorConfig = { workflows: {} }

    try {
      resolveWorkflow(empty, 'x', cwd)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('(none)')
    }
  })
})

describe('loadConfig', () => {
  // loadConfig uses dynamic import, which cannot be easily unit-tested
  // with FakeFsService. These cases are covered by integration tests.
  // Here we verify ConfigLoadError is constructable and carries configPath.

  it('ConfigLoadError carries configPath', () => {
    const err = new ConfigLoadError('test', path('/foo/orch.config.ts'))

    expect(err.name).toBe('ConfigLoadError')
    expect(err.configPath).toBe(path('/foo/orch.config.ts'))
    expect(err.message).toBe('test')
  })
})
