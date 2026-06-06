// MIGRATED → tests-new/integration/cli/unknown-flag.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Smoke-level CLI test — runs the orch entry point with removed flags and
// asserts the process exits CONFIG_ERROR with a message pointing at
// --mode=two-pane. Uses bun run so the full argv pipeline (including
// parseArgv → main()) is exercised, not just the parser.

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ENTRY = path.resolve(import.meta.dir, '../../../src/cli/main.ts')
const EXIT_CONFIG_ERROR = 2

async function runCli(argv: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const tmpDir = await fs.mkdtemp('/tmp/orch-cli-test-')
  try {
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

describe.skip('CLI rejects removed flags', () => {
  it('--tmux exits CONFIG_ERROR with a message pointing at --mode=two-pane', async () => {
    const { exitCode, stderr } = await runCli(['run', 'brainstorm', '--tmux'])

    expect(exitCode).toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('--tmux')
    expect(stderr).toContain('--mode=two-pane')
  }, 10_000)

  it('--observe exits CONFIG_ERROR with a message pointing at --mode=two-pane', async () => {
    const { exitCode, stderr } = await runCli(['run', 'brainstorm', '--observe'])

    expect(exitCode).toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('--observe')
    expect(stderr).toContain('--mode=two-pane')
  }, 10_000)
})
