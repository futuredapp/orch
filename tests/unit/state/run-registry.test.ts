import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../src/services/index.ts'
import { FileRunRegistry, type RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

async function seedRunDirs(fs: FakeFsService, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await fs.mkdir(path(`/runs/${id}`), { recursive: true })
  }
}

describe('FileRunRegistry', () => {
  it('listRuns returns empty array when base directory does not exist', async () => {
    const fs = new FakeFsService()
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const runs = await registry.listRuns()

    expect(runs).toEqual([])
  })

  it('listRuns returns empty array when base directory is empty', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(BASE, { recursive: true })
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const runs = await registry.listRuns()

    expect(runs).toEqual([])
  })

  it('listRuns returns sorted run IDs', async () => {
    const fs = new FakeFsService()
    await seedRunDirs(fs, [
      'r-2026-04-10-888392-ru',
      'r-2026-04-08-574464-as',
      'r-2026-04-09-318720-wz',
    ])
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const runs = await registry.listRuns()

    expect(runs).toEqual([
      rid('r-2026-04-08-574464-as'),
      rid('r-2026-04-09-318720-wz'),
      rid('r-2026-04-10-888392-ru'),
    ])
  })

  it('listRuns ignores non-matching directory entries', async () => {
    const fs = new FakeFsService()
    await seedRunDirs(fs, ['r-2026-04-10-913048-xr'])
    // Seed non-matching entries
    await fs.mkdir(path('/runs/.DS_Store'), { recursive: true })
    await fs.mkdir(path('/runs/notes.txt'), { recursive: true })
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const runs = await registry.listRuns()

    expect(runs).toEqual([rid('r-2026-04-10-913048-xr')])
  })

  it('findLatest returns undefined when no runs exist', async () => {
    const fs = new FakeFsService()
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const latest = await registry.findLatest()

    expect(latest).toBeUndefined()
  })

  it('findLatest returns the most recent run', async () => {
    const fs = new FakeFsService()
    await seedRunDirs(fs, [
      'r-2026-04-08-574464-as',
      'r-2026-04-10-888392-ru',
      'r-2026-04-09-318720-wz',
    ])
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const latest = await registry.findLatest()

    expect(latest).toBe(rid('r-2026-04-10-888392-ru'))
  })

  it('findByPrefix returns matching runs', async () => {
    const fs = new FakeFsService()
    await seedRunDirs(fs, [
      'r-2026-04-08-574464-as',
      'r-2026-04-10-888392-ru',
      'r-2026-04-10-849664-bv',
      'r-2026-04-09-318720-wz',
    ])
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const matches = await registry.findByPrefix('r-2026-04-10')

    expect(matches).toEqual([rid('r-2026-04-10-849664-bv'), rid('r-2026-04-10-888392-ru')])
  })

  it('findByPrefix returns empty array when nothing matches', async () => {
    const fs = new FakeFsService()
    await seedRunDirs(fs, ['r-2026-04-10-888392-ru'])
    const registry = new FileRunRegistry({ fs, basePath: BASE })

    const matches = await registry.findByPrefix('r-2025-01-01')

    expect(matches).toEqual([])
  })
})
