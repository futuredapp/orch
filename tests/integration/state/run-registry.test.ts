import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { BunFsService, path } from '../../../src/services/index.ts'
import { FileRunRegistry, type RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

describe('FileRunRegistry (integration)', () => {
  it('lists runs from a real temp directory', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-registry-test-')
    const bunFs = new BunFsService()

    await fs.mkdir(`${tmpDir}/r-2026-04-10-cc00`)
    await fs.mkdir(`${tmpDir}/r-2026-04-08-aa00`)
    await fs.mkdir(`${tmpDir}/r-2026-04-09-bb00`)

    const registry = new FileRunRegistry({ fs: bunFs, basePath: path(tmpDir) })

    const runs = await registry.listRuns()

    expect(runs).toEqual([
      rid('r-2026-04-08-aa00'),
      rid('r-2026-04-09-bb00'),
      rid('r-2026-04-10-cc00'),
    ])
  })
})
