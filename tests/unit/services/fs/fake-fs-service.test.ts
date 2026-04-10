import { describe, expect, it } from 'bun:test'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../../src/services/types.ts'

async function collectAsync(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

describe('FakeFsService', () => {
  it('round-trips writeFile and readFile for a single path', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/data'), { recursive: true })

    await fs.writeFile(path('/data/file.txt'), 'hello world')
    const content = await fs.readFile(path('/data/file.txt'))

    expect(content).toBe('hello world')
  })

  it('flips exists from false to true after writeFile and back to false after remove', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/data'), { recursive: true })

    expect(await fs.exists(path('/data/file.txt'))).toBe(false)

    await fs.writeFile(path('/data/file.txt'), 'content')
    expect(await fs.exists(path('/data/file.txt'))).toBe(true)

    await fs.remove(path('/data/file.txt'))
    expect(await fs.exists(path('/data/file.txt'))).toBe(false)
  })

  it('performs an atomic rename that removes the source and creates the destination', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/data'), { recursive: true })

    await fs.writeFile(path('/data/source.txt'), 'payload')
    await fs.rename(path('/data/source.txt'), path('/data/dest.txt'))

    expect(await fs.exists(path('/data/source.txt'))).toBe(false)
    expect(await fs.readFile(path('/data/dest.txt'))).toBe('payload')
  })

  it('creates nested paths when mkdir is called with recursive true', async () => {
    const fs = new FakeFsService()

    await fs.mkdir(path('/a/b/c'), { recursive: true })

    expect(await fs.exists(path('/a'))).toBe(true)
    expect(await fs.exists(path('/a/b'))).toBe(true)
    expect(await fs.exists(path('/a/b/c'))).toBe(true)
  })

  it('throws when mkdir is called non-recursively on a missing parent', async () => {
    const fs = new FakeFsService()

    expect(fs.mkdir(path('/a/b/c'))).rejects.toThrow()
  })

  it('matches glob patterns **/*.json and foo/*.md over the in-memory tree', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/root/foo'), { recursive: true })
    await fs.mkdir(path('/root/bar'), { recursive: true })
    await fs.writeFile(path('/root/foo/a.json'), '{}')
    await fs.writeFile(path('/root/foo/b.md'), '# B')
    await fs.writeFile(path('/root/bar/c.json'), '{}')

    const jsonFiles = (await collectAsync(fs.glob('**/*.json', { cwd: path('/root') }))).sort()
    expect(jsonFiles).toEqual([path('bar/c.json'), path('foo/a.json')])

    const mdFiles = await collectAsync(fs.glob('foo/*.md', { cwd: path('/root') }))
    expect(mdFiles).toEqual([path('foo/b.md')])
  })

  it('lists direct children via readDir', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/parent'), { recursive: true })
    await fs.writeFile(path('/parent/a.txt'), 'a')
    await fs.writeFile(path('/parent/b.txt'), 'b')
    await fs.mkdir(path('/parent/sub'), { recursive: true })

    const children = (await fs.readDir(path('/parent'))).slice().sort()

    expect(children).toEqual([path('a.txt'), path('b.txt'), path('sub')])
  })

  it('reports size and mtimeMs via stat on a file', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/data'), { recursive: true })
    await fs.writeFile(path('/data/file.txt'), 'hello')

    const s = await fs.stat(path('/data/file.txt'))

    expect(s.size).toBe(5)
    expect(typeof s.mtimeMs).toBe('number')
    expect(s.mtimeMs).toBeGreaterThan(0)
  })

  it('returns a unique temp directory path per tempDir invocation', async () => {
    const fs = new FakeFsService()

    const dir1 = await fs.tempDir('test-')
    const dir2 = await fs.tempDir('test-')

    expect(dir1).not.toBe(dir2)
    expect(await fs.exists(dir1)).toBe(true)
    expect(await fs.exists(dir2)).toBe(true)
  })

  it('overwrites existing files on writeFile without requiring an explicit remove', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/data'), { recursive: true })

    await fs.writeFile(path('/data/file.txt'), 'original')
    await fs.writeFile(path('/data/file.txt'), 'updated')
    const content = await fs.readFile(path('/data/file.txt'))

    expect(content).toBe('updated')
  })
})
