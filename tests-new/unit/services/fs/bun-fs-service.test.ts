import { describe, expect, it } from 'bun:test'
import { BunFsService } from '../../../../src/services/fs/bun-fs-service.ts'
import { path } from '../../../../src/services/index.ts'

const fakeHomedir = () => '/Users/fake-user'

describe('BunFsService.remove() protected-root guard', () => {
  it('refuses to remove the filesystem root', async () => {
    const fs = new BunFsService({ homedir: fakeHomedir })

    await expect(fs.remove(path('/'))).rejects.toThrow(/protected root/)
  })

  it('refuses to remove the current user home directory', async () => {
    const fs = new BunFsService({ homedir: fakeHomedir })

    await expect(fs.remove(path('/Users/fake-user'))).rejects.toThrow(/protected root/)
  })

  it('refuses to remove the direct parent of the home directory', async () => {
    const fs = new BunFsService({ homedir: fakeHomedir })

    await expect(fs.remove(path('/Users'))).rejects.toThrow(/protected root/)
  })

  it('allows removing an ordinary file under a real temp directory', async () => {
    const fs = new BunFsService({ homedir: fakeHomedir })
    const tmpDir = await fs.tempDir('orch-g1-')
    const filePath = path(`${tmpDir}/victim.txt`)
    await fs.writeFile(filePath, 'data')

    await fs.remove(filePath)

    expect(await fs.exists(filePath)).toBe(false)
  })
})
