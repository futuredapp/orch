import { describe, expect, it } from 'bun:test'
import { BunFsService } from '../../../../src/services/fs/bun-fs-service.ts'
import { FakeFsService } from '../../../../src/services/fs/fake-fs-service.ts'
import { path } from '../../../../src/services/index.ts'

describe('FakeFsService.symlink', () => {
  it('creates a link that exists() reports true and that resolves to the target on read', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })
    await fs.writeFile(path('/a/target.txt'), 'real content')

    await fs.symlink(path('/a/target.txt'), path('/a/link.txt'))

    expect(await fs.exists(path('/a/link.txt'))).toBe(true)
    expect(await fs.readFile(path('/a/link.txt'))).toBe('real content')
  })

  it('removing the link leaves the target intact', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })
    await fs.writeFile(path('/a/target.txt'), 'real content')
    await fs.symlink(path('/a/target.txt'), path('/a/link.txt'))

    await fs.remove(path('/a/link.txt'))

    expect(await fs.exists(path('/a/link.txt'))).toBe(false)
    expect(await fs.readFile(path('/a/target.txt'))).toBe('real content')
  })
})

describe('BunFsService.symlink', () => {
  it('creates a real symlink that exists() reports true and that resolves to the target', async () => {
    const fs = new BunFsService()
    const dir = await fs.tempDir('orch-symlink-')
    const target = path(`${dir}/target.txt`)
    const link = path(`${dir}/link.txt`)
    await fs.writeFile(target, 'real content')

    await fs.symlink(target, link)

    expect(await fs.exists(link)).toBe(true)
    expect(await fs.readFile(link)).toBe('real content')

    await fs.remove(dir)
  })
})
