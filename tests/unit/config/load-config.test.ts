// MIGRATED → tests-new/unit/config/load-config.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import {
  ConfigLoadError,
  defineConfig,
  findConfigPath,
  type OrchestratorConfig,
  PROMPTS_DISCOVERY_DEFAULTS,
  resolvePromptsConfig,
  resolveWorkflow,
} from '../../../src/config/index.ts'
import { type Path, path } from '../../../src/services/index.ts'

describe.skip('defineConfig', () => {
  it('returns the config unchanged as a typed identity function', () => {
    const input = { workflows: { deploy: './workflows/deploy.ts' } }

    const result = defineConfig(input)

    expect(result).toEqual(input)
  })
})

describe.skip('resolveWorkflow', () => {
  const config: OrchestratorConfig = {
    workflows: {
      deploy: './workflows/deploy.ts',
      migrate: 'workflows/migrate.ts',
      absolute: '/opt/workflows/abs.ts',
    },
  }
  const baseDir = path('/project')

  it('resolves a relative workflow path against the config directory', () => {
    const result = resolveWorkflow(config, 'deploy', baseDir)

    expect(result).toBe(path('/project/./workflows/deploy.ts'))
  })

  it('resolves a relative path without dot prefix against the config directory', () => {
    const result = resolveWorkflow(config, 'migrate', baseDir)

    expect(result).toBe(path('/project/workflows/migrate.ts'))
  })

  it('keeps an absolute path as-is', () => {
    const result = resolveWorkflow(config, 'absolute', baseDir)

    expect(result).toBe(path('/opt/workflows/abs.ts'))
  })

  it('resolves relative entries against an isolated `.orch/` config directory', () => {
    const result = resolveWorkflow(config, 'migrate', path('/project/.orch'))

    expect(result).toBe(path('/project/.orch/workflows/migrate.ts'))
  })

  it('throws on an unknown workflow name', () => {
    expect(() => resolveWorkflow(config, 'nope', baseDir)).toThrow('Unknown workflow "nope"')
  })

  it('lists available workflows in the error message', () => {
    try {
      resolveWorkflow(config, 'nope', baseDir)
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

    expect(() => resolveWorkflow(evil, 'hack', baseDir)).toThrow('..')
  })

  it('shows (none) when config has an empty workflow map', () => {
    const empty: OrchestratorConfig = { workflows: {} }

    try {
      resolveWorkflow(empty, 'x', baseDir)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('(none)')
    }
  })
})

describe.skip('findConfigPath', () => {
  function fakeExistsFor(present: ReadonlyArray<string>) {
    const set = new Set(present)
    return async (p: Path): Promise<boolean> => set.has(p)
  }

  it('prefers `.orch/orch.config.ts` over a sibling root-level config', async () => {
    const exists = fakeExistsFor(['/project/.orch/orch.config.ts', '/project/orch.config.ts'])

    const result = await findConfigPath(path('/project'), { exists })

    expect(result).toBe(path('/project/.orch/orch.config.ts'))
  })

  it('falls back to root-level `orch.config.ts` when no `.orch/` is present', async () => {
    const exists = fakeExistsFor(['/project/orch.config.ts'])

    const result = await findConfigPath(path('/project'), { exists })

    expect(result).toBe(path('/project/orch.config.ts'))
  })

  it('walks up to find a `.orch/orch.config.ts` in an ancestor directory', async () => {
    const exists = fakeExistsFor(['/project/.orch/orch.config.ts'])

    const result = await findConfigPath(path('/project/sub/deep'), { exists })

    expect(result).toBe(path('/project/.orch/orch.config.ts'))
  })

  it('walks up to find a root-level `orch.config.ts` in an ancestor directory', async () => {
    const exists = fakeExistsFor(['/project/orch.config.ts'])

    const result = await findConfigPath(path('/project/sub/deep'), { exists })

    expect(result).toBe(path('/project/orch.config.ts'))
  })

  it('prefers a closer `.orch/orch.config.ts` over a more distant root-level one', async () => {
    const exists = fakeExistsFor(['/project/sub/.orch/orch.config.ts', '/project/orch.config.ts'])

    const result = await findConfigPath(path('/project/sub'), { exists })

    expect(result).toBe(path('/project/sub/.orch/orch.config.ts'))
  })

  it('returns undefined when no config exists in any ancestor', async () => {
    const exists = fakeExistsFor([])

    const result = await findConfigPath(path('/project/sub'), { exists })

    expect(result).toBeUndefined()
  })
})

describe.skip('loadConfig', () => {
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

describe.skip('resolvePromptsConfig', () => {
  it('returns the documented defaults when prompts is omitted', () => {
    const config: OrchestratorConfig = { workflows: {} }

    expect(resolvePromptsConfig(config)).toBe(PROMPTS_DISCOVERY_DEFAULTS)
  })

  it('returns explicit user config verbatim when prompts is set', () => {
    const config: OrchestratorConfig = {
      workflows: {},
      prompts: { include: ['custom/**/*.md'], exclude: ['custom/skip.md'] },
    }

    expect(resolvePromptsConfig(config)).toEqual({
      include: ['custom/**/*.md'],
      exclude: ['custom/skip.md'],
    })
  })

  it('defaults cover the recommended on-disk layout', () => {
    expect(PROMPTS_DISCOVERY_DEFAULTS.include).toContain('.orch/workflows/**/*.md')
    expect(PROMPTS_DISCOVERY_DEFAULTS.include).toContain('.orch/prompts/**/*.md')
    expect(PROMPTS_DISCOVERY_DEFAULTS.exclude).toEqual([])
  })
})
