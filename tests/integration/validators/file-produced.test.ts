import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { stepName } from '../../../src/core/types.ts'
import { BunFsService, FakeGitService, path } from '../../../src/services/index.ts'
import {
  fileProduced,
  type ValidatorCtx,
  type ValidatorServices,
} from '../../../src/validators/index.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeCtx(cwd: string): { ctx: ValidatorCtx; services: ValidatorServices } {
  return {
    services: { fs: new BunFsService(), git: new FakeGitService() },
    ctx: { stepName: stepName('plan'), cwd: path(cwd), value: undefined },
  }
}

describe('fileProduced (integration, real BunFsService)', () => {
  it('returns ok when a matching file exists under a real temp dir', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'orch-fp-'))
    await fs.writeFile(nodePath.join(tmpDir, 'notes.md'), '# hello')
    const { services, ctx } = makeCtx(tmpDir)

    const result = await fileProduced('*.md').run(services, ctx)

    expect(result.ok).toBe(true)
  })

  it('returns a failure on an empty real temp dir', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'orch-fp-'))
    const { services, ctx } = makeCtx(tmpDir)

    const result = await fileProduced('*.md').run(services, ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('*.md')
    }
  })

  it('matches nested files via the ** glob against a real temp dir', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'orch-fp-'))
    await fs.mkdir(nodePath.join(tmpDir, 'sub', 'deeper'), { recursive: true })
    await fs.writeFile(nodePath.join(tmpDir, 'sub', 'deeper', 'note.md'), 'nested')
    const { services, ctx } = makeCtx(tmpDir)

    const result = await fileProduced('**/*.md').run(services, ctx)

    expect(result.ok).toBe(true)
  })
})
