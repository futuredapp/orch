import { describe, expect, it } from 'bun:test'
import { BunFsService } from '../../../../src/services/fs/bun-fs-service.ts'
import type { Path } from '../../../../src/services/types.ts'

async function collectAsync(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

describe('BunFsService', () => {
  let fs: BunFsService
  let tmpDir: Path

  const setup = async () => {
    fs = new BunFsService()
    tmpDir = await fs.tempDir('orch-phase1-')
  }

  it('round-trips writeFile and readFile against a real temp directory', async () => {
    await setup()
    const filePath = `${tmpDir}/test.txt` as Path

    await fs.writeFile(filePath, 'hello world')
    const content = await fs.readFile(filePath)

    expect(content).toBe('hello world')
  })

  it('creates a real temp directory with the requested prefix', async () => {
    await setup()

    expect(tmpDir).toContain('orch-phase1-')
    expect(await fs.exists(tmpDir)).toBe(true)
  })

  it('performs an atomic rename on the real filesystem', async () => {
    await setup()
    const source = `${tmpDir}/source.txt` as Path
    const dest = `${tmpDir}/dest.txt` as Path

    await fs.writeFile(source, 'payload')
    await fs.rename(source, dest)

    expect(await fs.exists(source)).toBe(false)
    expect(await fs.readFile(dest)).toBe('payload')
  })

  it('matches glob patterns over a real directory tree', async () => {
    await setup()
    await fs.mkdir(`${tmpDir}/sub` as Path)
    await fs.writeFile(`${tmpDir}/a.json` as Path, '{}')
    await fs.writeFile(`${tmpDir}/sub/b.json` as Path, '{}')
    await fs.writeFile(`${tmpDir}/c.txt` as Path, 'text')

    const matches = (await collectAsync(fs.glob('**/*.json', { cwd: tmpDir }))).sort()

    expect(matches.length).toBe(2)
    expect(matches.some((m) => String(m).includes('a.json'))).toBe(true)
    expect(matches.some((m) => String(m).includes('b.json'))).toBe(true)
  })

  it('removes files and reports exists false afterward', async () => {
    await setup()
    const filePath = `${tmpDir}/removeme.txt` as Path

    await fs.writeFile(filePath, 'data')
    expect(await fs.exists(filePath)).toBe(true)

    await fs.remove(filePath)
    expect(await fs.exists(filePath)).toBe(false)
  })

  it('reports size and mtimeMs via stat on a real file', async () => {
    await setup()
    const filePath = `${tmpDir}/stat-test.txt` as Path

    await fs.writeFile(filePath, 'hello')
    const s = await fs.stat(filePath)

    expect(s.size).toBe(5)
    expect(typeof s.mtimeMs).toBe('number')
    expect(s.mtimeMs).toBeGreaterThan(0)
  })

  it('creates nested directories with mkdir recursive on the real filesystem', async () => {
    await setup()
    const nested = `${tmpDir}/a/b/c` as Path

    await fs.mkdir(nested, { recursive: true })

    expect(await fs.exists(nested)).toBe(true)
  })
})
