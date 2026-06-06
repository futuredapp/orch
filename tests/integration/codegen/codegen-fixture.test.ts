// MIGRATED → tests-new/integration/codegen/codegen-fixture.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCodegen } from '../../../src/codegen/index.ts'
import { BunFsService } from '../../../src/services/fs/bun-fs-service.ts'
import { path } from '../../../src/services/types.ts'

// Real-FS integration test for the sidecar codegen. We use BunFsService
// (which delegates to Bun.Glob) rather than the in-memory fake, so this
// test catches glob-syntax / encoding mismatches the fake would mask.

describe.skip('runCodegen — real-fs integration', () => {
  let projectRoot: string
  const fs = new BunFsService()

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'orch-codegen-fixture-'))
    await fs.mkdir(path(`${projectRoot}/.orch/prompts`), { recursive: true })
    await writeFile(
      `${projectRoot}/.orch/prompts/brainstorm.md`,
      'Topic: {{topic}}\nDepth: {{depth?}}\n',
    )
    await writeFile(`${projectRoot}/.orch/prompts/static.md`, 'no placeholders here\n')
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  it('writes one .d.ts per prompt source on a clean tree', async () => {
    const result = await runCodegen(
      { fs },
      {
        configDir: path(projectRoot),
        include: ['.orch/prompts/**/*.md'],
        exclude: [],
      },
    )

    expect(result.errors).toEqual([])
    expect(result.written.length).toBe(2)

    const sidecar = await readFile(`${projectRoot}/.orch/prompts/brainstorm.md.d.ts`, 'utf8')
    expect(sidecar).toContain(`declare module 'orch'`)
    expect(sidecar).toContain(`"@/.orch/prompts/brainstorm.md"`)
    expect(sidecar).toContain('topic: string | number | boolean')
    expect(sidecar).toContain('depth?: string | number | boolean')
    expect(sidecar.trimEnd().endsWith('export {}')).toBe(true)
  })

  it('emits Record<string, never> for placeholder-free sources', async () => {
    await runCodegen(
      { fs },
      {
        configDir: path(projectRoot),
        include: ['.orch/prompts/**/*.md'],
        exclude: [],
      },
    )

    const sidecar = await readFile(`${projectRoot}/.orch/prompts/static.md.d.ts`, 'utf8')
    expect(sidecar).toContain(': Record<string, never>')
  })

  it('is idempotent — a second run writes nothing', async () => {
    await runCodegen(
      { fs },
      { configDir: path(projectRoot), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    const second = await runCodegen(
      { fs },
      { configDir: path(projectRoot), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    expect(second.written).toEqual([])
    expect(second.skipped.length).toBe(2)
    expect(second.errors).toEqual([])
  })

  it('rewrites the sidecar when the source content changes', async () => {
    await runCodegen(
      { fs },
      { configDir: path(projectRoot), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )
    await writeFile(
      `${projectRoot}/.orch/prompts/brainstorm.md`,
      'Topic: {{topic}}\nTone: {{tone?}}\n',
    )

    const second = await runCodegen(
      { fs },
      { configDir: path(projectRoot), include: ['.orch/prompts/**/*.md'], exclude: [] },
    )

    expect(second.written.some((p) => p.endsWith('brainstorm.md'))).toBe(true)
    const sidecar = await readFile(`${projectRoot}/.orch/prompts/brainstorm.md.d.ts`, 'utf8')
    expect(sidecar).toContain('tone?: string | number | boolean')
    expect(sidecar).not.toContain('depth?')
  })

  it('expands brace globs through Bun.Glob', async () => {
    await writeFile(`${projectRoot}/.orch/prompts/notes.txt`, 'Hi {{name}}\n')

    const result = await runCodegen(
      { fs },
      {
        configDir: path(projectRoot),
        include: ['.orch/prompts/**/*.{md,txt}'],
        exclude: [],
      },
    )

    expect(result.written.length).toBe(3)
    const txtSidecar = await readFile(`${projectRoot}/.orch/prompts/notes.txt.d.ts`, 'utf8')
    expect(txtSidecar).toContain('name: string | number | boolean')
  })
})
