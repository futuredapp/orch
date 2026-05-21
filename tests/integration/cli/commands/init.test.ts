// Handler-level integration tests for `orch init`. The CLI plumbing is
// covered by tests/integration/cli/main-dispatch.test.ts (subprocess) and
// tests/integration/cli/commands/init-e2e.test.ts (full Bun.spawn). These
// tests construct CliDeps with FakeFsService + FakeConfirmService so each
// flow is deterministic and side-effect-free.

import { describe, expect, it } from 'bun:test'
import { initCmd } from '../../../../src/cli/commands/init.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT } from '../../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import {
  FakeClock,
  FakeConfirmService,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  FakePromptService,
  path,
} from '../../../../src/services/index.ts'
import { FileRunRegistry, FileStateStore } from '../../../../src/state/index.ts'

const DEFAULT_OPTS: CliOpts = {
  mode: undefined,
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
}

interface DepsOverrides {
  readonly fs?: FakeFsService
  readonly confirm?: FakeConfirmService
  readonly cwd?: string
  readonly isStdinTty?: boolean
}

function makeDeps(overrides: DepsOverrides = {}): CliDeps {
  const fs = overrides.fs ?? new FakeFsService()
  const basePath = path('/state-not-used')
  const cwdPath = path(overrides.cwd ?? '/proj')
  return {
    processService: new FakeProcessService(),
    fsService: fs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath }),
    registry: new FileRunRegistry({ fs, basePath }),
    cwd: cwdPath,
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: overrides.confirm ?? new FakeConfirmService(),
    isStdinTty: overrides.isStdinTty ?? true,
  }
}

describe('initCmd — F1 clean-project flow', () => {
  it('creates the canonical .orch/ tree and .gitignore when neither exists', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    const deps = makeDeps({ fs })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    expect(await fs.exists(path('/proj/.orch/orch.config.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/steps.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/workflows/hello.ts'))).toBe(true)
    expect(await fs.exists(path('/proj/.orch/state'))).toBe(true)
    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('.orch/state/\n')
  })

  it('preserves an existing .gitignore and appends the new line', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/.gitignore'), 'node_modules\n')
    const deps = makeDeps({ fs })

    await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('node_modules\n.orch/state/\n')
  })

  it('is idempotent on .gitignore when the line is already present', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/.gitignore'), 'node_modules\n.orch/state/\n')
    const deps = makeDeps({ fs })

    await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('node_modules\n.orch/state/\n')
  })

  it('scaffolds a manifest registering the hello workflow (covers AE5 prep)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    const deps = makeDeps({ fs })

    await initCmd(deps, '', {}, DEFAULT_OPTS)

    const manifest = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(manifest).toContain("hello: 'workflows/hello.ts'")
    expect(manifest).toContain('export const config')
  })

  it('does not invoke the confirmService on the clean-project F1 path', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    const confirm = new FakeConfirmService()
    const deps = makeDeps({ fs, confirm })

    await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(confirm.recorded()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// F2 — re-init flow
// ---------------------------------------------------------------------------

async function seedExistingOrch(fs: FakeFsService): Promise<void> {
  await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
  await fs.mkdir(path('/proj/.orch/state/r-2026-05-15-abc'), { recursive: true })
  await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'old hello content')
  await fs.writeFile(
    path('/proj/.orch/workflows/my-real-workflow.ts'),
    '// preserved user workflow\nexport default 1',
  )
  await fs.writeFile(path('/proj/.orch/steps.ts'), 'old steps content')
  await fs.writeFile(
    path('/proj/.orch/orch.config.ts'),
    "export const config = { workflows: { hello: 'workflows/hello.ts' } }",
  )
  await fs.writeFile(path('/proj/.orch/state/r-2026-05-15-abc/state.json'), '{}')
}

describe('initCmd — F2 re-init flow', () => {
  it('AE1 (R7): declining the replace prompt exits 0 and leaves files untouched', async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    const confirm = new FakeConfirmService([false])
    const deps = makeDeps({ fs, confirm })

    const beforeHello = await fs.readFile(path('/proj/.orch/workflows/hello.ts'))
    const beforeUser = await fs.readFile(path('/proj/.orch/workflows/my-real-workflow.ts'))

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    // Only the first prompt was asked — the keep-workflows prompt must not fire.
    expect(confirm.recorded()).toHaveLength(1)
    expect(confirm.recorded()[0]?.question).toContain('already exists')

    // Files unchanged.
    expect(await fs.readFile(path('/proj/.orch/workflows/hello.ts'))).toBe(beforeHello)
    expect(await fs.readFile(path('/proj/.orch/workflows/my-real-workflow.ts'))).toBe(beforeUser)
    expect(await fs.exists(path('/proj/.orch/state/r-2026-05-15-abc/state.json'))).toBe(true)
  })

  it('AE2 (R7 + R8 keep): preserves user workflows and state, rewrites scaffolded files', async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    const confirm = new FakeConfirmService([true, true])
    const deps = makeDeps({ fs, confirm })

    const userBefore = await fs.readFile(path('/proj/.orch/workflows/my-real-workflow.ts'))

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    // Both prompts asked.
    expect(confirm.recorded()).toHaveLength(2)

    // User workflow + state preserved.
    expect(await fs.readFile(path('/proj/.orch/workflows/my-real-workflow.ts'))).toBe(userBefore)
    expect(await fs.exists(path('/proj/.orch/state/r-2026-05-15-abc/state.json'))).toBe(true)

    // Scaffolded files rewritten to fresh content.
    expect(await fs.readFile(path('/proj/.orch/workflows/hello.ts'))).toContain(
      "export default workflow('hello'",
    )
    expect(await fs.readFile(path('/proj/.orch/steps.ts'))).toContain('export const HELLO')

    // Manifest contains both the rewritten hello entry AND my-real-workflow.
    const manifest = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(manifest).toContain("hello: 'workflows/hello.ts'")
    expect(manifest).toContain('my-real-workflow')
  })

  it("AE3 (R8 don't-keep): wipes .orch/ and re-scaffolds fresh", async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    const confirm = new FakeConfirmService([true, false])
    const deps = makeDeps({ fs, confirm })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    expect(confirm.recorded()).toHaveLength(2)

    // User workflow gone.
    expect(await fs.exists(path('/proj/.orch/workflows/my-real-workflow.ts'))).toBe(false)
    // State directory gone.
    expect(await fs.exists(path('/proj/.orch/state/r-2026-05-15-abc'))).toBe(false)
    // Fresh scaffolded files present.
    expect(await fs.readFile(path('/proj/.orch/workflows/hello.ts'))).toContain(
      "export default workflow('hello'",
    )
    expect(await fs.exists(path('/proj/.orch/state'))).toBe(true)

    // Manifest is the fresh single-workflow shape.
    const manifest = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(manifest).toContain("hello: 'workflows/hello.ts'")
    expect(manifest).not.toContain('my-real-workflow')
  })

  it('AE4 (R9): refuses up-front when --noninteractive even with TTY', async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    const confirm = new FakeConfirmService()
    const deps = makeDeps({ fs, confirm })

    const code = await initCmd(deps, '', {}, { ...DEFAULT_OPTS, interactivity: 'noninteractive' })

    expect(code).toBe(EXIT.CONFIG_ERROR)
    // No prompts asked.
    expect(confirm.recorded()).toEqual([])
    // No file mutations.
    expect(await fs.readFile(path('/proj/.orch/workflows/hello.ts'))).toBe('old hello content')
  })

  it('R9 via piped stdin (isStdinTty=false) refuses identically', async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    const confirm = new FakeConfirmService()
    const deps = makeDeps({ fs, confirm, isStdinTty: false })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(confirm.recorded()).toEqual([])
  })

  it('R2 guard still fires in re-init context (before any prompt)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/repo'), { recursive: true })
    await fs.writeFile(path('/repo/package.json'), JSON.stringify({ name: 'orch' }))
    await fs.mkdir(path('/repo/src/cli'), { recursive: true })
    await fs.writeFile(path('/repo/src/cli/main.ts'), 'export {}')
    await fs.mkdir(path('/repo/.orch'), { recursive: true })
    const confirm = new FakeConfirmService()
    const deps = makeDeps({ fs, confirm, cwd: '/repo' })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(confirm.recorded()).toEqual([])
  })

  it('declining the replace prompt leaves .gitignore untouched', async () => {
    const fs = new FakeFsService()
    await seedExistingOrch(fs)
    await fs.writeFile(path('/proj/.gitignore'), 'node_modules\n')
    const confirm = new FakeConfirmService([false])
    const deps = makeDeps({ fs, confirm })

    await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(await fs.readFile(path('/proj/.gitignore'))).toBe('node_modules\n')
  })
})

// ---------------------------------------------------------------------------
// Zod-import warning (C from the A+C plan): the cleanest workflow imports
// `z` from 'orch'. If a user-authored file in .orch/ imports from 'zod'
// directly, init should warn so the host project isn't silently broken when
// the workflow runs.
// ---------------------------------------------------------------------------

interface CapturedIO {
  readonly stderr: () => string
  readonly restore: () => void
}

function captureStderr(): CapturedIO {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(process.stderr as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  return {
    stderr: () => chunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(process.stderr as any).write = orig
    },
  }
}

describe('initCmd — zod-import warning', () => {
  it('clean F1 init prints no zod warning (scaffold files use orch)', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    const deps = makeDeps({ fs })

    const io = captureStderr()
    try {
      await initCmd(deps, '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(io.stderr()).not.toContain("import directly from 'zod'")
  })

  it('reinit keep-mode warns when a preserved user workflow imports from "zod"', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'old hello')
    await fs.writeFile(
      path('/proj/.orch/workflows/feature.ts'),
      "import { z } from 'zod'\nimport { workflow } from 'orch'\nexport default workflow('feature', async () => {})\n",
    )
    await fs.writeFile(path('/proj/.orch/steps.ts'), 'old steps')
    await fs.writeFile(
      path('/proj/.orch/orch.config.ts'),
      "export const config = { workflows: { hello: 'workflows/hello.ts' } }",
    )
    const confirm = new FakeConfirmService([true, true])
    const deps = makeDeps({ fs, confirm })

    const io = captureStderr()
    let code: number
    try {
      code = await initCmd(deps, '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(code).toBe(EXIT.OK)
    const err = io.stderr()
    expect(err).toContain("import directly from 'zod'")
    expect(err).toContain('/proj/.orch/workflows/feature.ts')
    expect(err).toContain("import { z } from 'orch'")
    expect(err).toContain('bun add zod')
  })

  it('reinit keep-mode prints no zod warning when preserved workflows use orch', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj/.orch/workflows'), { recursive: true })
    await fs.writeFile(path('/proj/.orch/workflows/hello.ts'), 'old hello')
    await fs.writeFile(
      path('/proj/.orch/workflows/feature.ts'),
      "import { z, workflow } from 'orch'\nexport default workflow('feature', async () => {})\n",
    )
    await fs.writeFile(path('/proj/.orch/steps.ts'), 'old steps')
    await fs.writeFile(
      path('/proj/.orch/orch.config.ts'),
      "export const config = { workflows: { hello: 'workflows/hello.ts' } }",
    )
    const confirm = new FakeConfirmService([true, true])
    const deps = makeDeps({ fs, confirm })

    const io = captureStderr()
    try {
      await initCmd(deps, '', {}, DEFAULT_OPTS)
    } finally {
      io.restore()
    }

    expect(io.stderr()).not.toContain("import directly from 'zod'")
  })
})

describe('initCmd — R2 self-detection guard', () => {
  it('refuses to run when cwd looks like the orch source repo', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/repo'), { recursive: true })
    await fs.writeFile(path('/repo/package.json'), JSON.stringify({ name: 'orch' }))
    await fs.mkdir(path('/repo/src/cli'), { recursive: true })
    await fs.writeFile(path('/repo/src/cli/main.ts'), 'export {}')
    const deps = makeDeps({ fs, cwd: '/repo' })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    // No `.orch/` written — refusal precedes any writes.
    expect(await fs.exists(path('/repo/.orch'))).toBe(false)
  })

  it('proceeds when the host package.json declares a different name', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    await fs.writeFile(path('/proj/package.json'), JSON.stringify({ name: 'host-project' }))
    const deps = makeDeps({ fs })

    const code = await initCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    expect(await fs.exists(path('/proj/.orch/orch.config.ts'))).toBe(true)
  })
})
