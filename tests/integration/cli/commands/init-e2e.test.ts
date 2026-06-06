// Subprocess-level smoke tests for `orch init` and `orch new`. These run
// the real CLI binary via Bun.spawn against a tmpdir cwd, asserting on the
// observable side effects (exit code + on-disk files). The handler-level
// tests in init.test.ts / new.test.ts give detailed coverage; this file
// is the belt-and-suspenders check that the full
// Bun.argv → parseArgv → main() → handler path works end-to-end.

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

const ENTRY = nodePath.resolve(import.meta.dir, '../../../../src/cli/main.ts')

async function runCli(
  argv: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', ENTRY, ...argv], {
    cwd,
    env: { ...process.env, CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

describe('orch init — end-to-end', () => {
  it('scaffolds the .orch/ tree and writes .gitignore in a fresh tmpdir', async () => {
    const tmp = await fs.mkdtemp('/tmp/orch-init-e2e-')
    try {
      const { exitCode } = await runCli(['init'], tmp)

      expect(exitCode).toBe(0)
      // The four scaffolded files exist on disk.
      await fs.access(nodePath.join(tmp, '.orch', 'orch.config.ts'))
      await fs.access(nodePath.join(tmp, '.orch', 'steps.ts'))
      await fs.access(nodePath.join(tmp, '.orch', 'workflows', 'hello.ts'))
      await fs.access(nodePath.join(tmp, '.orch', 'state'))
      const gitignore = await fs.readFile(nodePath.join(tmp, '.gitignore'), 'utf-8')
      expect(gitignore).toContain('.orch/state/')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }, 15_000)

  it('orch init followed by orch new my-feature: both files exist and manifest lists both', async () => {
    const tmp = await fs.mkdtemp('/tmp/orch-new-e2e-')
    try {
      const initResult = await runCli(['init'], tmp)
      expect(initResult.exitCode).toBe(0)

      const newResult = await runCli(['new', 'my-feature'], tmp)
      expect(newResult.exitCode).toBe(0)

      await fs.access(nodePath.join(tmp, '.orch', 'workflows', 'hello.ts'))
      await fs.access(nodePath.join(tmp, '.orch', 'workflows', 'my-feature.ts'))
      const manifest = await fs.readFile(nodePath.join(tmp, '.orch', 'orch.config.ts'), 'utf-8')
      expect(manifest).toContain("hello: 'workflows/hello.ts'")
      expect(manifest).toContain("'my-feature': 'workflows/my-feature.ts'")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }, 20_000)

  it('orch init invoked from the orch source repo exits 2 with the R2 refusal', async () => {
    // We invoke from the actual repo root — the R2 guard must fire there.
    const repoRoot = nodePath.resolve(import.meta.dir, '../../../..')
    const { exitCode, stderr } = await runCli(['init'], repoRoot)

    expect(exitCode).toBe(2)
    expect(stderr).toContain('orch source repository')
  }, 15_000)
})
