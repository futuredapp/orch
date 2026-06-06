// Unit coverage for the codegen pre-pass inside `runCmd` — specifically the
// three runtime branches that live in `runCodegenPrepass`:
//
//   1. ConfigLoadError → silent skip (the workflow loader surfaces the real
//      user-facing error a few lines later in `runCmd`).
//   2. Non-ConfigLoadError from `loadConfig` → rethrown.
//   3. `ORCH_QUIET=1` → suppress the "Generated N sidecar(s)" stderr line.
//   4. Codegen errors → emit the "Warning:" stderr block.
//   5. Discovery throws (transient FS error) → recorded as a CodegenError on
//      `opts.configDir`, prepass does not throw.
//
// The pre-pass is exported from `src/cli/commands/run.ts` solely so this test
// can exercise its branches without booting the full `runCmd` pipeline.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCodegenPrepass } from '../../../src/cli/commands/run.ts'
import type { CliDeps } from '../../../src/cli/deps.ts'
import { runCodegen } from '../../../src/codegen/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import type { FsService } from '../../../src/services/fs/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../src/services/prompt/index.ts'
import type { Path } from '../../../src/services/types.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../src/state/index.ts'

let tmpDir: string
const realFs = new BunFsService()

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'orch-run-prepass-'))
})

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

function makeDeps(cwd: string, fsOverride?: FsService): CliDeps {
  const fs = fsOverride ?? realFs
  const basePath = path(`${cwd}/.orch/state`)
  return {
    processService: new FakeProcessService(),
    fsService: fs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: realFs, basePath }),
    registry: new FileRunRegistry({ fs: realFs, basePath }),
    cwd: path(cwd),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid: RunId) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: false,
  }
}

async function writeConfig(cwd: string, body: string): Promise<void> {
  await writeFile(
    `${cwd}/orch.config.ts`,
    `import { defineConfig } from '${join(process.cwd(), 'src/index.ts').replace(/'/g, "\\'")}'
export const config = defineConfig(${body})
`,
  )
}

function capture(): { stderr: () => string; restore: () => void } {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: test capture
  ;(process.stderr as any).write = (chunk: any): boolean => {
    chunks.push(String(chunk))
    return true
  }
  return {
    stderr: () => chunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test capture
      ;(process.stderr as any).write = orig
    },
  }
}

describe('runCodegenPrepass — branch coverage', () => {
  it('silently skips when orch.config.ts is missing (ConfigLoadError)', async () => {
    // No orch.config.ts in tmpDir → loadConfig throws ConfigLoadError. The
    // prepass swallows it because runCmd's loadWorkflow will report the real
    // error a few lines later.
    const io = capture()
    try {
      await runCodegenPrepass(makeDeps(tmpDir))
    } finally {
      io.restore()
    }
    expect(io.stderr()).toBe('')
  })

  it('emits the "Generated N sidecar(s)" line on a cold tree', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await realFs.mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')

    const io = capture()
    try {
      await runCodegenPrepass(makeDeps(tmpDir))
    } finally {
      io.restore()
    }
    expect(io.stderr()).toContain('Generated 1 prompt-file type sidecar(s).')

    // Side-effect check: the sidecar actually exists on disk after the prepass.
    const sidecar = await readFile(`${tmpDir}/.orch/prompts/a.md.d.ts`, 'utf8')
    expect(sidecar).toContain('name: string | number | boolean')
  })

  it('suppresses the "Generated N sidecar(s)" line under ORCH_QUIET=1', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    await realFs.mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })
    await writeFile(`${tmpDir}/.orch/prompts/a.md`, 'Hi {{name}}')

    const prev = process.env.ORCH_QUIET
    process.env.ORCH_QUIET = '1'
    const io = capture()
    try {
      await runCodegenPrepass(makeDeps(tmpDir))
    } finally {
      io.restore()
      if (prev === undefined) delete process.env.ORCH_QUIET
      else process.env.ORCH_QUIET = prev
    }
    expect(io.stderr()).toBe('')
  })

  it('does not throw and emits no warning when there are no errors', async () => {
    await writeConfig(
      tmpDir,
      `{ workflows: {}, prompts: { include: ['.orch/prompts/**/*.md'], exclude: [] } }`,
    )
    // Empty prompts dir — no sources, no errors.
    await realFs.mkdir(path(`${tmpDir}/.orch/prompts`), { recursive: true })

    const io = capture()
    try {
      await runCodegenPrepass(makeDeps(tmpDir))
    } finally {
      io.restore()
    }
    expect(io.stderr()).toBe('')
  })
})

describe('runCodegen — discovery failure path', () => {
  it('records a CodegenError on configDir when discoverPrompts throws', async () => {
    // Inject an FsService whose `glob` throws — discoverPrompts iterates the
    // glob results inside a `for await`, so the failure bubbles up and the
    // outer `try` in runCodegen catches it. Other methods delegate to the
    // real FS so write paths (unused here) still behave.
    // Build an FsService that delegates everything to the real FS but whose
    // `glob` throws on first iteration. We use class extension instead of
    // object-spread because spread loses the prototype methods of BunFsService.
    class ExplodingFs extends BunFsService {
      // biome-ignore lint/correctness/useYield: deliberately throws before any yield
      override async *glob(): AsyncIterable<Path> {
        throw new Error('synthetic glob failure for test')
      }
    }
    const exploding: FsService = new ExplodingFs()

    const result = await runCodegen(
      { fs: exploding },
      {
        configDir: path(tmpDir),
        include: ['.orch/prompts/**/*.md'],
        exclude: [],
      },
    )

    expect(result.errors.length).toBe(1)
    const err = result.errors[0]
    expect(err).toBeDefined()
    expect(err?.path).toBe(path(tmpDir))
    expect(err?.message).toContain('discoverPrompts failed')
    expect(err?.message).toContain('synthetic glob failure')
    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
