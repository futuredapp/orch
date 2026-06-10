// CLI-level dispatch tests for the `init` and `new` config-free commands.
//
// These exercise the full Bun.argv → parseArgv → main() → handler path so
// the banner-gating logic in main.ts (CONFIG_FREE_COMMANDS branch) is
// covered end-to-end. The init/new commands themselves are stubbed at this
// point (U1 wires dispatch; U5/U6/U7 flesh out the behavior).

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ENTRY = path.resolve(import.meta.dir, '../../../src/cli/main.ts')
const EXIT_OK = 0
const EXIT_CONFIG_ERROR = 2

async function runCli(
  argv: string[],
  opts: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const tmpDir = await fs.mkdtemp('/tmp/orch-dispatch-test-')
  try {
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...argv], {
      cwd: tmpDir,
      env: { ...process.env, CI: 'true', ...(opts.env ?? {}) },
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

describe('config-free dispatch — init and new', () => {
  it('orch init exits 0 and does not print the [orch] mode=... banner', async () => {
    const { exitCode, stderr } = await runCli(['init'])

    expect(exitCode).toBe(EXIT_OK)
    expect(stderr).not.toContain('[orch] mode=')
  }, 10_000)

  it('orch new foo does not print the [orch] mode=... banner', async () => {
    // Exit code depends on whether `.orch/` is present (CONFIG_ERROR without
    // it); the dispatch contract under test is the banner suppression.
    const { stderr } = await runCli(['new', 'foo'])

    expect(stderr).not.toContain('[orch] mode=')
  }, 10_000)

  it('orch --help lists both init and new with one-line descriptions', async () => {
    const { exitCode, stdout } = await runCli(['--help'])

    expect(exitCode).toBe(EXIT_OK)
    expect(stdout).toContain('init')
    expect(stdout).toContain('new')
    expect(stdout).toContain('Scaffold')
  }, 10_000)

  it('orch init --mode=two-pane does not crash on tmux probe (banner skipped entirely)', async () => {
    // CI=true + no TTY + no tmux available should normally fail mode
    // resolution. The CONFIG_FREE_COMMANDS branch must short-circuit before
    // resolveMode runs, so init returns OK regardless of the flag.
    const { exitCode } = await runCli(['init', '--mode=two-pane'])

    expect(exitCode).toBe(EXIT_OK)
  }, 10_000)
})

describe('config-free dispatch — regressions for non-init commands', () => {
  it('unknown command still exits 2 with "Unknown command:" message', async () => {
    const { exitCode, stderr } = await runCli(['fnord'])

    expect(exitCode).toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('Unknown command:')
  }, 10_000)
})

// Regression for the Homebrew/compiled-binary crash: the steps-view child is
// launched by re-invoking the binary as `orch __steps-view --opts <b64>`. The
// dispatcher MUST route that to the runner — not treat it as an unknown command
// (which printed usage + exit 2, killing the left pane). We exercise it without
// `--opts` so the runner fails fast (exit 1) instead of mounting a live Ink TUI.
describe('internal subcommand dispatch — __steps-view re-entry', () => {
  it('routes __steps-view to the steps-view runner instead of "Unknown command"', async () => {
    const { exitCode, stderr } = await runCli(['__steps-view'])

    expect(stderr).not.toContain('Unknown command:')
    expect(exitCode).not.toBe(EXIT_CONFIG_ERROR)
    // The runner's own missing-args failure — proof we reached it.
    expect(stderr).toContain('--opts')
  }, 10_000)

  it('routes __ask to the ask runner instead of "Unknown command"', async () => {
    const { exitCode, stderr } = await runCli(['__ask'])

    expect(stderr).not.toContain('Unknown command:')
    expect(exitCode).not.toBe(EXIT_CONFIG_ERROR)
    // The ink-runner's own missing-args failure — proof we reached it.
    expect(stderr).toContain('--spec')
  }, 10_000)
})
