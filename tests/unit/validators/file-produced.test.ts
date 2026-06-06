import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { FakeFsService, FakeGitService, path } from '../../../src/services/index.ts'
import {
  fileProduced,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'

function makeCtx(): { ctx: ValidatorCtx; services: ValidatorServices; fs: FakeFsService } {
  const fs = new FakeFsService()
  return {
    fs,
    services: { fs, git: new FakeGitService() },
    ctx: { stepName: stepName('plan'), cwd: path('/work'), value: undefined },
  }
}

describe('fileProduced', () => {
  it('carries a name that embeds the glob for clear failure messages', () => {
    const v = fileProduced('**/*.md')

    expect(v.name).toBe('fileProduced(**/*.md)')
  })

  it('returns ok when at least one file matches the glob under cwd', async () => {
    const { fs, services, ctx } = makeCtx()
    await fs.mkdir(path('/work'), { recursive: true })
    await fs.writeFile(path('/work/notes.md'), 'hello')

    const result = await fileProduced('*.md').run(services, ctx)

    expect(result.ok).toBe(true)
  })

  it('returns a failure with glob and cwd in the reason when no files match', async () => {
    const { fs, services, ctx } = makeCtx()
    await fs.mkdir(path('/work'), { recursive: true })

    const result = await fileProduced('*.md').run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('*.md')
      expect(result.reason).toContain('/work')
      expect(result.hint).toBeDefined()
    }
  })

  it('throws synchronously on an empty glob at factory time', () => {
    expect(() => fileProduced('')).toThrow('must not be empty')
  })

  it('throws synchronously on a whitespace-only glob at factory time', () => {
    expect(() => fileProduced('   ')).toThrow('must not be empty')
  })

  it('throws synchronously on an absolute path glob at factory time', () => {
    expect(() => fileProduced('/etc/passwd')).toThrow('absolute paths are not allowed')
  })

  it('throws synchronously on a tilde-prefixed glob at factory time', () => {
    expect(() => fileProduced('~/secrets/*')).toThrow('tilde-prefixed paths are not allowed')
  })

  it('throws synchronously on a glob containing a .. component at factory time', () => {
    expect(() => fileProduced('src/../../etc/passwd')).toThrow('parent-traversal')
  })

  it('short-circuits on the first match without consuming the full iterator', async () => {
    const { services, ctx } = makeCtx()
    let yieldedCount = 0
    const spyingFs = {
      ...services.fs,
      async *glob(_pattern: string) {
        yieldedCount += 1
        yield path('a.md')
        yieldedCount += 1
        yield path('b.md')
        yieldedCount += 1
        yield path('c.md')
      },
    } as unknown as typeof services.fs
    const spyingServices: ValidatorServices = { ...services, fs: spyingFs }

    const result = await fileProduced('*.md').run(spyingServices, ctx)

    expect(result.ok).toBe(true)
    expect(yieldedCount).toBe(1)
  })
})
