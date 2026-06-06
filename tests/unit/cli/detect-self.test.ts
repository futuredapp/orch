// MIGRATED → tests-new/unit/cli/detect-self.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { isInsideOrchSourceRepo } from '../../../src/cli/commands/detect-self.ts'
import { FakeFsService, path } from '../../../src/services/index.ts'

async function seed(fs: FakeFsService, files: Record<string, string>): Promise<void> {
  for (const [p, content] of Object.entries(files)) {
    const segments = p.split('/').slice(0, -1).join('/')
    if (segments) await fs.mkdir(path(segments), { recursive: true })
    await fs.writeFile(path(p), content)
  }
}

describe.skip('isInsideOrchSourceRepo', () => {
  it('returns true when package.json name is "orch" AND src/cli/main.ts exists', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/repo/package.json': JSON.stringify({ name: 'orch' }),
      '/repo/src/cli/main.ts': 'export {}',
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/repo'))).toBe(true)
  })

  it('returns false when package.json declares a different name', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/host/package.json': JSON.stringify({ name: 'host-project' }),
      '/host/src/cli/main.ts': 'export {}',
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/host'))).toBe(false)
  })

  it('returns false when src/cli/main.ts is absent (incomplete repo)', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/repo/package.json': JSON.stringify({ name: 'orch' }),
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/repo'))).toBe(false)
  })

  it('returns false when package.json is missing entirely', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/empty'), { recursive: true })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/empty'))).toBe(false)
  })

  it('returns false when package.json is malformed JSON', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/repo/package.json': '{ this is not json',
      '/repo/src/cli/main.ts': 'export {}',
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/repo'))).toBe(false)
  })

  it('returns false when package.json parses to a non-object top-level value', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/repo/package.json': '"a bare string"',
      '/repo/src/cli/main.ts': 'export {}',
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/repo'))).toBe(false)
  })

  it('returns false from a subdirectory of the orch source repo (only literal cwd is checked)', async () => {
    const fs = new FakeFsService()
    await seed(fs, {
      '/repo/package.json': JSON.stringify({ name: 'orch' }),
      '/repo/src/cli/main.ts': 'export {}',
      '/repo/sub/dir/marker.txt': '',
    })

    expect(await isInsideOrchSourceRepo({ fsService: fs }, path('/repo/sub/dir'))).toBe(false)
  })
})
