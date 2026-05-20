import { describe, expect, it } from 'bun:test'
import {
  appendWorkflowToManifest,
  ensureGitignoreLine,
  preservingReinitFiles,
  removeOrchTree,
  writeOrchTree,
} from '../../../../src/cli/commands/scaffold.ts'
import { FakeFsService, path } from '../../../../src/services/index.ts'

describe('writeOrchTree', () => {
  it('creates the workflows + state directories and scaffolds the four files', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })

    await writeOrchTree(fs, path('/proj/.orch'))

    expect(await fs.exists(path('/proj/.orch/workflows'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/state'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/orch.config.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/steps.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/workflows/hello.ts'))).toBe(true)
  })

  it('does not touch files outside the target orchDir', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/keep.txt'), 'keep')

    await writeOrchTree(fs, path('/proj/.orch'))

    expect(await fs.readFile(path('/proj/keep.txt'))).toBe('keep')
  })
})

describe('ensureGitignoreLine', () => {
  it('creates the file with exactly one line + trailing newline when absent', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })

    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('.orch/state/\n')
  })

  it('is idempotent: running twice does not duplicate the line', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })

    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')
    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('.orch/state/\n')
  })

  it('appends without disturbing existing lines (file ends in newline)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/.gitignore'), 'node_modules\n')

    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('node_modules\n.orch/state/\n')
  })

  it('inserts a leading newline when the existing file lacks a trailing one', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/.gitignore'), 'node_modules')

    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('node_modules\n.orch/state/\n')
  })

  it('treats whitespace-trimmed matches as present (does not duplicate)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/.gitignore'), '  .orch/state/  \nnode_modules\n')

    await ensureGitignoreLine(fs, path('/proj/.gitignore'), '.orch/state/')

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('  .orch/state/  \nnode_modules\n')
  })
})

describe('removeOrchTree', () => {
  it('rejects paths that do not end with /.orch', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/state'), { recursive: true })

    await expect(removeOrchTree(fs, path('/proj/state'))).rejects.toThrow(
      /only paths ending in \/\.orch are allowed/,
    )
  })

  it('removes the tree recursively for a path ending in /.orch', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/orch.config.ts'), 'x')
    await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'y')

    await removeOrchTree(fs, path('/proj/.orch'))

    expect(await fs.exists(path('/proj/.orch'))).toBe(false)
    expect(await fs.exists(path('/proj/.orch/orch.config.ts'))).toBe(false)
    expect(await fs.exists(path('/proj/.orch/workflows/hello.ts'))).toBe(false)
  })
})

describe('preservingReinitFiles', () => {
  it('returns every .ts file in workflows/ except hello.ts', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'h')
    await fs.writeFile(path('/proj/.orch/workflows/alpha.ts'), 'a')
    await fs.writeFile(path('/proj/.orch/workflows/beta.ts'), 'b')
    await fs.writeFile(path('/proj/.orch/workflows/readme.md'), 'r')

    const { preservedWorkflows } = await preservingReinitFiles(fs, path('/proj/.orch'))

    const names = preservedWorkflows.map((p) => p.split('/').pop()).sort()
    expect(names).toEqual(['alpha.ts', 'beta.ts'])
  })

  it('returns an empty list when only hello.ts is present', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'h')

    const { preservedWorkflows } = await preservingReinitFiles(fs, path('/proj/.orch'))

    expect(preservedWorkflows).toEqual([])
  })

  it('returns an empty list when workflows/ does not exist', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch'), { recursive: true })

    const { preservedWorkflows } = await preservingReinitFiles(fs, path('/proj/.orch'))

    expect(preservedWorkflows).toEqual([])
  })
})

describe('appendWorkflowToManifest', () => {
  const baseManifest = `import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: {
    hello: 'workflows/hello.ts',
  },
})
`

  it('adds a new entry to the workflows map while preserving surrounding content', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/orch.config.ts'), baseManifest)

    await appendWorkflowToManifest(
      fs,
      path('/proj/.orch/orch.config.ts'),
      'my-feature',
      'workflows/my-feature.ts',
    )

    const updated = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(updated).toContain("hello: 'workflows/hello.ts'")
    expect(updated).toContain("'my-feature': 'workflows/my-feature.ts'")
    expect(updated).toContain("import { defineConfig } from 'orch'")
    expect(updated).toContain('export const config')
  })

  it('appends multiple workflows in the order they were added', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/orch.config.ts'), baseManifest)

    await appendWorkflowToManifest(
      fs,
      path('/proj/.orch/orch.config.ts'),
      'alpha',
      'workflows/alpha.ts',
    )
    await appendWorkflowToManifest(
      fs,
      path('/proj/.orch/orch.config.ts'),
      'beta',
      'workflows/beta.ts',
    )

    const updated = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    const alphaIdx = updated.indexOf("'alpha':")
    const betaIdx = updated.indexOf("'beta':")
    expect(alphaIdx).toBeGreaterThan(0)
    expect(betaIdx).toBeGreaterThan(alphaIdx)
  })

  it('throws a clear actionable error when the workflows-block regex does not match', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch'), { recursive: true })
    await fs.writeFile(
      path('/proj/.orch/orch.config.ts'),
      "import { defineConfig } from 'orch'\nexport const config = defineConfig({ workflows: makeWorkflows() })\n",
    )

    await expect(
      appendWorkflowToManifest(fs, path('/proj/.orch/orch.config.ts'), 'foo', 'workflows/foo.ts'),
    ).rejects.toThrow(/edited in a way orch new can't safely modify/)
  })

  it('produces a manifest that still parses as valid TypeScript after insertion', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/orch.config.ts'), baseManifest)

    await appendWorkflowToManifest(
      fs,
      path('/proj/.orch/orch.config.ts'),
      'my-feature',
      'workflows/my-feature.ts',
    )

    const updated = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    // Confirms no syntax got smashed by the regex insertion.
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(updated)).not.toThrow()
  })
})
