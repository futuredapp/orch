// Phase B — interactive step declared under --mode=plain must exit with the
// brainstorm's message and a CONFIG_ERROR code, *before* any runner spawn.
// Drives the real CLI entry point so the full mapRunError path is exercised.

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ENTRY = path.resolve(import.meta.dir, '../../../src/cli/main.ts')
const REPO_ROOT = path.resolve(import.meta.dir, '../../..')
const EXIT_CONFIG_ERROR = 2

const WORKFLOW_SOURCE = `import { step, workflow } from '${REPO_ROOT}/src/core/index.ts'
import { FakeRunner } from '${REPO_ROOT}/src/runners/index.ts'
import { FakeProcessService } from '${REPO_ROOT}/src/services/index.ts'

const agent = new FakeRunner(new FakeProcessService())
export default workflow('interactive-plain', async (run) => {
  await run(step.define('brainstorm', { agent, mode: 'interactive' }))
})
`

const CONFIG_SOURCE = `import { defineConfig } from '${REPO_ROOT}/src/config/index.ts'

export default defineConfig({
  workflows: {
    'interactive-plain': './interactive-plain.workflow.ts',
  },
})
`

async function runCli(
  argv: string[],
  setup: (cwd: string) => Promise<void>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const tmpDir = await fs.mkdtemp('/tmp/orch-interactive-plain-')
  try {
    await setup(tmpDir)
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...argv], {
      cwd: tmpDir,
      env: { ...process.env, CI: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

describe('interactive step under --mode=plain', () => {
  it('exits CONFIG_ERROR with "use --mode=two-pane" pointing at the step name', async () => {
    const { exitCode, stderr } = await runCli(
      ['run', 'interactive-plain', '--mode=plain'],
      async (cwd) => {
        await fs.writeFile(path.join(cwd, 'orch.config.ts'), CONFIG_SOURCE)
        await fs.writeFile(path.join(cwd, 'interactive-plain.workflow.ts'), WORKFLOW_SOURCE)
      },
    )

    expect(exitCode).toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('brainstorm')
    expect(stderr).toContain('use --mode=two-pane')
  }, 15_000)
})
