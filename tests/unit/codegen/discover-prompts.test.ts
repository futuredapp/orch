// MIGRATED → tests-new/unit/codegen/discover-prompts.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { discoverPrompts, expandBraces } from '../../../src/codegen/discover-prompts.ts'
import { FakeFsService } from '../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../src/services/types.ts'

describe.skip('expandBraces', () => {
  it('passes a non-brace pattern through unchanged', () => {
    expect(expandBraces('*.md')).toEqual(['*.md'])
  })

  it('expands a single brace group', () => {
    expect(expandBraces('*.{md,txt}')).toEqual(['*.md', '*.txt'])
  })

  it('expands an embedded brace group', () => {
    expect(expandBraces('.orch/prompts/**/*.{md,txt}')).toEqual([
      '.orch/prompts/**/*.md',
      '.orch/prompts/**/*.txt',
    ])
  })

  it('cross-multiplies multiple brace groups', () => {
    expect(expandBraces('{a,b}-{x,y}')).toEqual(['a-x', 'a-y', 'b-x', 'b-y'])
  })
})

describe.skip('discoverPrompts', () => {
  async function withSeededFs(seed: readonly string[]): Promise<FakeFsService> {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    for (const filePath of seed) {
      const idx = filePath.lastIndexOf('/')
      if (idx > 0) {
        await fs.mkdir(path(filePath.slice(0, idx)), { recursive: true })
      }
      await fs.writeFile(path(filePath), '')
    }
    return fs
  }

  it('returns files matching a single include glob', async () => {
    const fs = await withSeededFs([
      '/proj/.orch/prompts/a.md',
      '/proj/.orch/prompts/b.md',
      '/proj/.orch/other/c.md',
    ])

    const result = await discoverPrompts(fs, path('/proj'), ['.orch/prompts/**/*.md'], [])

    expect(result.map(String)).toEqual(['/proj/.orch/prompts/a.md', '/proj/.orch/prompts/b.md'])
  })

  it('expands brace globs across .md and .txt', async () => {
    const fs = await withSeededFs([
      '/proj/.orch/prompts/a.md',
      '/proj/.orch/prompts/b.txt',
      '/proj/.orch/prompts/c.json',
    ])

    const result = await discoverPrompts(fs, path('/proj'), ['.orch/prompts/**/*.{md,txt}'], [])

    expect(result.map(String)).toEqual(['/proj/.orch/prompts/a.md', '/proj/.orch/prompts/b.txt'])
  })

  it('filters out files matched by exclude', async () => {
    const fs = await withSeededFs(['/proj/.orch/prompts/a.md', '/proj/.orch/prompts/skip.md'])

    const result = await discoverPrompts(
      fs,
      path('/proj'),
      ['.orch/prompts/**/*.md'],
      ['.orch/prompts/skip.md'],
    )

    expect(result.map(String)).toEqual(['/proj/.orch/prompts/a.md'])
  })

  it('returns paths sorted ASCII for stable downstream ordering', async () => {
    const fs = await withSeededFs([
      '/proj/.orch/prompts/zeta.md',
      '/proj/.orch/prompts/alpha.md',
      '/proj/.orch/prompts/beta.md',
    ])

    const result = await discoverPrompts(fs, path('/proj'), ['.orch/prompts/**/*.md'], [])

    expect(result.map(String)).toEqual([
      '/proj/.orch/prompts/alpha.md',
      '/proj/.orch/prompts/beta.md',
      '/proj/.orch/prompts/zeta.md',
    ])
  })

  it('returns an empty list when no files match', async () => {
    const fs = await withSeededFs(['/proj/.orch/prompts/a.md'])

    const result = await discoverPrompts(fs, path('/proj'), ['.orch/workflows/**/*.md'], [])

    expect(result.map(String)).toEqual([])
  })
})
