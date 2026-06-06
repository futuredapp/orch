// MIGRATED → tests-new/integration/cli/run-builtin.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Handler-level integration tests for the `orch::` built-in resolver branch in
// loadWorkflow. These drive the real loadConfig + dynamic import() path against
// a temp `.orch/` so the resolver contract is proven end-to-end: an orch::
// name loads the packaged built-in and never touches config.workflows, while
// bare names resolve exactly as before.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoadError, loadWorkflow } from '../../../src/cli/commands/load-workflow.ts'
import { path } from '../../../src/services/index.ts'

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../..')
const coreBarrel = nodePath.join(repoRoot, 'src', 'core', 'index.ts')

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-run-builtin-')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeConfig(workflows: Record<string, string>): Promise<void> {
  await fs.mkdir(nodePath.join(tmpDir, '.orch'), { recursive: true })
  const body = `export const config = { workflows: ${JSON.stringify(workflows)} }\n`
  await fs.writeFile(nodePath.join(tmpDir, '.orch', 'orch.config.ts'), body)
}

// User workflows resolve relative to the config dir (.orch/), so write them
// there to mirror the real on-disk layout.
async function writeUserWorkflow(file: string, name: string): Promise<void> {
  await fs.mkdir(nodePath.join(tmpDir, '.orch'), { recursive: true })
  const body = `import { workflow } from ${JSON.stringify(coreBarrel)}\nexport default workflow(${JSON.stringify(name)}, async () => {})\n`
  await fs.writeFile(nodePath.join(tmpDir, '.orch', file), body)
}

// Capture what loadWorkflow writes to stderr (it reports failures there).
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const result = await fn()
    return { result, stderr }
  } finally {
    process.stderr.write = original
  }
}

describe.skip('loadWorkflow — orch:: built-in resolution', () => {
  it('loads the packaged built-in and never consults config.workflows for an orch:: name', async () => {
    // The map would shadow the name with a non-existent module if it were
    // consulted — proving the orch:: branch bypasses it entirely.
    await writeConfig({ 'orch::work-cc': './does-not-exist.ts' })

    const loaded = await loadWorkflow(path(tmpDir), 'orch::work-cc')

    expect(isLoadError(loaded)).toBe(false)
    if (isLoadError(loaded)) return
    expect(loaded.executor.name).toBe('work-cc')
  })

  it('resolves a bare registered user workflow through config.workflows as before', async () => {
    await writeUserWorkflow('deploy.ts', 'user-deploy')
    await writeConfig({ deploy: './deploy.ts' })

    const loaded = await loadWorkflow(path(tmpDir), 'deploy')

    expect(isLoadError(loaded)).toBe(false)
    if (isLoadError(loaded)) return
    expect(loaded.executor.name).toBe('user-deploy')
  })

  it('still throws the existing unknown-workflow error for an unknown bare name', async () => {
    await writeConfig({})

    const { result, stderr } = await captureStderr(() => loadWorkflow(path(tmpDir), 'nope'))

    expect(isLoadError(result)).toBe(true)
    expect(stderr).toContain('Unknown workflow "nope"')
  })

  it('reports the available built-ins for an unknown orch:: name', async () => {
    await writeConfig({})

    const { result, stderr } = await captureStderr(() => loadWorkflow(path(tmpDir), 'orch::nope'))

    expect(isLoadError(result)).toBe(true)
    expect(stderr).toContain('Unknown built-in workflow "orch::nope"')
    expect(stderr).toContain('orch::work-cc')
  })

  it('surfaces the config error (not a locator error) when an orch:: run has no .orch/', async () => {
    // No config written — loadConfig fails before the resolver branch runs.
    const { result, stderr } = await captureStderr(() =>
      loadWorkflow(path(tmpDir), 'orch::work-cc'),
    )

    expect(isLoadError(result)).toBe(true)
    expect(stderr).toContain('config')
    expect(stderr).not.toContain('built-in')
  })
})
