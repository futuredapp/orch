// ---------------------------------------------------------------------------
// Binary smoke test — the compiled `orch` artifact actually boots and
// dispatches its internal TUI re-entry subcommands.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, AND WHY IT'S SEPARATE FROM EVERY OTHER SUITE:
//
// A `bun build --compile` binary behaves differently from a dev checkout —
// `process.execPath` is the binary itself (not a generic `bun`), and embedded
// modules resolve under Bun's virtual FS (`/$bunfs/...`). The Homebrew launch
// bug (left pane spawned as `orch /$bunfs/.../steps-view-runner.tsx` →
// "Unknown command" → exit 2 → dead pane) is INVISIBLE to the unit/integration
// suites because they run under `bun`, where those two facts don't hold.
//
// This suite builds the real artifact and asserts, headlessly (no tmux, no
// agent), the two things that can only break in the binary:
//   1. The runner modules do NOT self-execute at import time and hijack startup
//      (`--help` must print usage, not a runner's missing-args error).
//   2. The internal subcommands route to their runners instead of falling
//      through to "Unknown command".
//
// It is deliberately NOT in any `bun test <glob>` used by `bun run check` (the
// build adds seconds). It runs via `bun run test:binary-smoke`, gated into
// `check:release`. A full two-pane render check needs tmux + a TTY and lives in
// the real-tmux harness.

import { beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const OUTFILE = path.resolve(import.meta.dir, '../../dist/orch')
const EXIT_CONFIG_ERROR = 2

async function buildBinary(): Promise<void> {
  const proc = Bun.spawn(['bun', 'scripts/build-binary.ts', '--outfile', 'dist/orch'], {
    cwd: path.resolve(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`build-binary failed (exit ${code}):\n${err}`)
  }
}

async function runBinary(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Run in a throwaway cwd so `runs`/state reads never touch the repo's .orch/.
  const tmpDir = await fs.mkdtemp('/tmp/orch-binary-smoke-')
  try {
    const proc = Bun.spawn([OUTFILE, ...args], {
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

describe('compiled binary — boot + internal subcommand dispatch', () => {
  beforeAll(async () => {
    await buildBinary()
  }, 120_000)

  it('boots `--help` without a runner self-exec hijacking startup', async () => {
    const { stdout, stderr } = await runBinary(['--help'])

    expect(stdout).toContain('Usage: orch <command> [options]')
    // The regression we guard: an embedded runner running at import time would
    // print its own missing-args error on EVERY command instead of the help.
    expect(stderr).not.toContain('steps-view-runner:')
    expect(stderr).not.toContain('ink-runner:')
  })

  it('routes __steps-view to the steps-view runner, not "Unknown command"', async () => {
    const { exitCode, stderr } = await runBinary(['__steps-view'])

    expect(stderr).not.toContain('Unknown command:')
    expect(exitCode).not.toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('--opts')
  })

  it('routes __ask to the ask runner, not "Unknown command"', async () => {
    const { exitCode, stderr } = await runBinary(['__ask'])

    expect(stderr).not.toContain('Unknown command:')
    expect(exitCode).not.toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('--spec')
  })
})
