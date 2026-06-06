// MIGRATED → tests-new/e2e/cli/orch-run.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'

const SKIP = !process.env.RUN_REAL_E2E

describe.skip('orch CLI (e2e)', () => {
  it.skipIf(SKIP)('orch --help exits 0 and prints usage', async () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/cli/main.ts', '--help'])

    expect(result.exitCode).toBe(0)
    const stdout = result.stdout.toString()
    expect(stdout).toContain('Usage: orch')
    expect(stdout).toContain('run <name>')
    expect(stdout).toContain('resume')
  })

  it.skipIf(SKIP)('orch with no arguments exits 2', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/cli/main.ts'])

    expect(result.exitCode).toBe(2)
  })

  it.skipIf(SKIP)('orch unknown-command exits 2', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/cli/main.ts', 'bogus'])

    expect(result.exitCode).toBe(2)
    const stderr = result.stderr.toString()
    expect(stderr).toContain('Unknown command')
  })

  it.skipIf(SKIP)('orch runs exits 0 even without state directory', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/cli/main.ts', 'runs'], {
      cwd: '/tmp',
    })

    expect(result.exitCode).toBe(0)
  })

  it.skipIf(SKIP)('orch run without a name exits 2', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/cli/main.ts', 'run'])

    expect(result.exitCode).toBe(2)
  })
})
