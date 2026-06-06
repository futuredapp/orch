// MIGRATED → tests-new/unit/services/fs/fake-fs-service-remove.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// FakeFsService.remove brought to parity with BunFsService.remove's
// `recursive: true, force: true` contract. The F2 "don't keep" branch of
// `orch init` calls `fsService.remove(.orch)` and depends on every nested
// workflow file going away in tests that use the fake.

import { describe, expect, it } from 'bun:test'
import { FakeFsService, path } from '../../../../src/services/index.ts'

describe.skip('FakeFsService.remove (recursive)', () => {
  it('removes the target and every descendant entry', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })
    await fs.mkdir(path('/a/b'), { recursive: true })
    await fs.mkdir(path('/a/b/d'), { recursive: true })
    await fs.writeFile(path('/a/b/c.txt'), 'c')
    await fs.writeFile(path('/a/b/d/e.txt'), 'e')
    await fs.writeFile(path('/a/other.txt'), 'other')

    await fs.remove(path('/a/b'))

    expect(await fs.exists(path('/a/b'))).toBe(false)
    expect(await fs.exists(path('/a/b/c.txt'))).toBe(false)
    expect(await fs.exists(path('/a/b/d'))).toBe(false)
    expect(await fs.exists(path('/a/b/d/e.txt'))).toBe(false)
    expect(await fs.exists(path('/a/other.txt'))).toBe(true)
  })

  it('removes a leaf directory cleanly when it has no children', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })
    await fs.mkdir(path('/a/b'), { recursive: true })

    await fs.remove(path('/a/b'))

    expect(await fs.exists(path('/a/b'))).toBe(false)
    expect(await fs.exists(path('/a'))).toBe(true)
  })

  it('is a no-op when the target does not exist (matches force: true)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })

    // Should not throw.
    await fs.remove(path('/a/nope'))

    expect(await fs.exists(path('/a'))).toBe(true)
  })

  it('does not delete siblings whose path shares a prefix (e.g. /a vs /aaa)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/a'), { recursive: true })
    await fs.mkdir(path('/aaa'), { recursive: true })
    await fs.writeFile(path('/aaa/x.txt'), 'x')

    await fs.remove(path('/a'))

    expect(await fs.exists(path('/aaa'))).toBe(true)
    expect(await fs.exists(path('/aaa/x.txt'))).toBe(true)
  })
})
