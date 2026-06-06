// MIGRATED → tests-new/integration/cli/commands/new.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Handler-level integration tests for `orch new`. The CLI plumbing is
// covered by tests/integration/cli/main-dispatch.test.ts (subprocess). These
// tests run against FakeFsService with a pre-scaffolded `.orch/` so each
// validation path can be exercised in isolation.

import { describe, expect, it } from 'bun:test'
import { newCmd } from '../../../../src/cli/commands/new.ts'
import { writeOrchTree } from '../../../../src/cli/commands/scaffold.ts'
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
  watch: false,
}

interface DepsOverrides {
  readonly fs?: FakeFsService
  readonly cwd?: string
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
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

async function withInitializedOrch(): Promise<{ fs: FakeFsService; deps: CliDeps }> {
  const fs = new FakeFsService()
  await fs.mkdir(path('/proj'), { recursive: true })
  await writeOrchTree(fs, path('/proj/.orch'))
  const deps = makeDeps({ fs })
  return { fs, deps }
}

describe.skip('newCmd — F3 happy path', () => {
  it('creates the workflow file and appends to the manifest', async () => {
    const { fs, deps } = await withInitializedOrch()

    const code = await newCmd(deps, 'my-feature', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.OK)
    expect(await fs.exists(path('/proj/.orch/workflows/my-feature.ts'))).toBe(true)
    const manifest = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(manifest).toContain("'my-feature': 'workflows/my-feature.ts'")
  })

  it('the scaffolded workflow file interpolates the name in the workflow() call', async () => {
    const { fs, deps } = await withInitializedOrch()

    await newCmd(deps, 'my-feature', {}, DEFAULT_OPTS)

    const content = await fs.readFile(path('/proj/.orch/workflows/my-feature.ts'))
    expect(content).toContain("workflow('my-feature'")
  })

  it('appends multiple workflows in the order they were added', async () => {
    const { fs, deps } = await withInitializedOrch()

    await newCmd(deps, 'alpha', {}, DEFAULT_OPTS)
    await newCmd(deps, 'beta', {}, DEFAULT_OPTS)

    const manifest = await fs.readFile(path('/proj/.orch/orch.config.ts'))
    expect(manifest).toContain("hello: 'workflows/hello.ts'")
    const alphaIdx = manifest.indexOf("'alpha':")
    const betaIdx = manifest.indexOf("'beta':")
    expect(alphaIdx).toBeGreaterThan(0)
    expect(betaIdx).toBeGreaterThan(alphaIdx)
  })
})

describe.skip('newCmd — R10 require .orch/', () => {
  it('exits 2 with a "No .orch/ found" message when .orch/ is absent', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/proj'), { recursive: true })
    const deps = makeDeps({ fs })

    const code = await newCmd(deps, 'foo', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(await fs.exists(path('/proj/.orch'))).toBe(false)
  })
})

describe.skip('newCmd — R11 name validation (AE6)', () => {
  it('rejects an uppercase name with a kebab-case error', async () => {
    const { fs, deps } = await withInitializedOrch()

    const code = await newCmd(deps, 'My_Workflow', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(await fs.exists(path('/proj/.orch/workflows/My_Workflow.ts'))).toBe(false)
  })

  it('rejects a name beginning with a digit', async () => {
    const { fs, deps } = await withInitializedOrch()

    const code = await newCmd(deps, '1st-flow', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(await fs.exists(path('/proj/.orch/workflows/1st-flow.ts'))).toBe(false)
  })

  it('rejects an empty name with a usage hint', async () => {
    const { deps } = await withInitializedOrch()

    const code = await newCmd(deps, '', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('rejects a name containing a slash', async () => {
    const { deps } = await withInitializedOrch()

    const code = await newCmd(deps, 'foo/bar', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('rejects a name containing path traversal segments', async () => {
    const { deps } = await withInitializedOrch()

    // path() would also reject this, but the regex must catch it first so
    // we never construct the Path.
    const code = await newCmd(deps, 'esc..ape', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })
})

describe.skip('newCmd — R12 no overwrite (AE7)', () => {
  it('exits 2 when the workflow file already exists and leaves it unchanged', async () => {
    const { fs, deps } = await withInitializedOrch()
    await fs.writeFile(path('/proj/.orch/workflows/build.ts'), 'user-content')

    const code = await newCmd(deps, 'build', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(await fs.readFile(path('/proj/.orch/workflows/build.ts'))).toBe('user-content')
  })
})

describe.skip('newCmd — manifest regex mismatch surface', () => {
  it('writes the workflow file but exits 2 with a clear "config has been edited" message', async () => {
    const { fs, deps } = await withInitializedOrch()
    // User reshapes the manifest in a way the regex can't reach.
    await fs.writeFile(
      path('/proj/.orch/orch.config.ts'),
      "import { defineConfig } from 'orch'\nexport const config = defineConfig({ workflows: makeWorkflows() })\n",
    )

    const code = await newCmd(deps, 'foo', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    // Workflow file *was* written before the manifest update failed —
    // user-facing message must tell them about this state.
    expect(await fs.exists(path('/proj/.orch/workflows/foo.ts'))).toBe(true)
  })
})

describe.skip('newCmd — R2 self-detection guard', () => {
  it('refuses to run inside the orch source repository', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path('/repo'), { recursive: true })
    await fs.writeFile(path('/repo/package.json'), JSON.stringify({ name: 'orch' }))
    await fs.mkdir(path('/repo/src/cli'), { recursive: true })
    await fs.writeFile(path('/repo/src/cli/main.ts'), 'export {}')
    await writeOrchTree(fs, path('/repo/.orch'))
    const deps = makeDeps({ fs, cwd: '/repo' })

    const code = await newCmd(deps, 'foo', {}, DEFAULT_OPTS)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(await fs.exists(path('/repo/.orch/workflows/foo.ts'))).toBe(false)
  })
})
