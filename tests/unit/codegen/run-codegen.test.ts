// MIGRATED → tests-new/unit/codegen/run-codegen.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { runCodegen } from '../../../src/codegen/run-codegen.ts'
import { FakeFsService } from '../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../src/services/types.ts'

async function seedFile(fs: FakeFsService, absPath: string, content: string): Promise<void> {
  const idx = absPath.lastIndexOf('/')
  if (idx > 0) await fs.mkdir(path(absPath.slice(0, idx)), { recursive: true })
  await fs.writeFile(path(absPath), content)
}

describe.skip('runCodegen', () => {
  it('writes one sidecar per discovered prompt file', async () => {
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/a.md', 'Hi {{name}}')
    await seedFile(fs, '/proj/.orch/prompts/b.md', 'Hello {{topic?}}')

    const result = await runCodegen(
      { fs },
      {
        configDir: path('/proj'),
        include: ['.orch/prompts/**/*.md'],
        exclude: [],
      },
    )

    expect(result.errors).toEqual([])
    expect(result.written.map(String)).toEqual([
      '/proj/.orch/prompts/a.md',
      '/proj/.orch/prompts/b.md',
    ])
    expect(await fs.exists(path('/proj/.orch/prompts/a.md.d.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/prompts/b.md.d.ts'))).toBe(true)
  })

  it('skips files whose sidecar already matches on disk', async () => {
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/a.md', 'Hi {{name}}')

    const first = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )
    expect(first.written.length).toBe(1)

    const second = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )
    expect(second.written).toEqual([])
    expect(second.skipped.map(String)).toEqual(['/proj/.orch/prompts/a.md'])
  })

  it('rewrites a sidecar when the source file changes', async () => {
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/a.md', 'Hi {{name}}')

    await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    await fs.writeFile(path('/proj/.orch/prompts/a.md'), 'Hi {{name}} {{tone?}}')

    const second = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    expect(second.written.map(String)).toEqual(['/proj/.orch/prompts/a.md'])
    const sidecar = await fs.readFile(path('/proj/.orch/prompts/a.md.d.ts'))
    expect(sidecar).toContain('tone?: string | number | boolean')
  })

  it('collects per-file errors without throwing', async () => {
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/a.md', 'Hi {{name}}')
    // Spy on readFile to inject a failure for one source path.
    const original = fs.readFile.bind(fs)
    fs.readFile = async (p) => {
      if (p === '/proj/.orch/prompts/a.md') throw new Error('synthetic read failure')
      return original(p)
    }

    const result = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    expect(result.written).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(String(result.errors[0]?.path)).toBe('/proj/.orch/prompts/a.md')
    expect(result.errors[0]?.message).toContain('synthetic read failure')
  })

  it('emits the registry key relative to configDir', async () => {
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/brainstorm.md', 'topic={{topic}} depth={{depth?}}')

    await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    const sidecar = await fs.readFile(path('/proj/.orch/prompts/brainstorm.md.d.ts'))
    expect(sidecar).toContain(`"@/.orch/prompts/brainstorm.md"`)
    expect(sidecar).toContain('topic: string | number | boolean')
    expect(sidecar).toContain('depth?: string | number | boolean')
  })

  it('returns an empty result when no sources match', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })

    const result = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('does not re-discover its own .d.ts sidecars on the next pass', async () => {
    // Finding #14: an include glob like `**/*.md` followed by an unscoped
    // `**/*` would otherwise loop the generated `.md.d.ts` sidecars back as
    // sources and try to emit `.md.d.ts.d.ts` next time. The exclusion lives
    // in runCodegen so even users with permissive globs are protected.
    const fs = new FakeFsService()
    await seedFile(fs, '/proj/.orch/prompts/a.md', 'Hi {{name}}')

    // First pass: writes a.md.d.ts.
    const first = await runCodegen(
      { fs },
      {
        configDir: path('/proj'),
        // A deliberately permissive include that would catch sidecars without
        // the filter — `**/*` matches `.md.d.ts`.
        include: ['**/*'],
        exclude: [],
      },
    )
    expect(first.written.length).toBe(1)
    expect(first.errors).toEqual([])

    // Second pass with the same permissive include must NOT see the sidecar
    // as a new source. Stable file count across two runs is the load-bearing
    // assertion.
    const second = await runCodegen(
      { fs },
      { configDir: path('/proj'), include: ['**/*'], exclude: [] },
    )
    expect(second.written).toEqual([])
    expect(second.skipped.map(String)).toEqual(['/proj/.orch/prompts/a.md'])
    expect(second.errors).toEqual([])

    // Sidecar of a sidecar must not exist.
    expect(await fs.exists(path('/proj/.orch/prompts/a.md.d.ts.d.ts'))).toBe(false)
  })
})
