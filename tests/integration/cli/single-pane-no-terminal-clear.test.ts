// Regression test — `--mode=single-pane` (deferred to v2) must not emit
// terminal-reset escape codes on stdout when it fails fast.
//
// Background: the CLI registered an unconditional `process.on('exit', ...)`
// at module load that wrote DEC private-mode resets to stdout for every
// exit path, intending to backstop tmux's leaked modes. The reset string
// includes `\x1b[?1049l` (exit alternate screen buffer). Several common
// terminals (Apple Terminal, iTerm2 in some configurations) interpret that
// sequence as a screen-buffer toggle even when the alt-screen was never
// entered — wiping the visible terminal content, including the error
// message just written to stderr.
//
// The user-visible symptom: `bunx orch run <foo> --mode=single-pane`
// appeared to "clear the CLI" and silently exit with no error and no
// `.orch/` directory created. That is exactly because the alt-screen-exit
// fired after the RunModeError stderr write, hiding it from view.
//
// We can't easily get a real PTY in a Bun test, but the reset hook gates
// on `process.stdout.isTTY === true`. By preloading a small script that
// forces `process.stdout.isTTY = true` in the subprocess, we make the
// hook fire even though stdout is a captured pipe — and we can then
// assert what bytes would have hit the user's terminal.

import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ENTRY = path.resolve(import.meta.dir, '../../../src/cli/main.ts')
const ALT_SCREEN_EXIT = '\x1b[?1049l'
const EXIT_CONFIG_ERROR = 2

async function runCliWithForcedTty(argv: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const tmpDir = await fs.mkdtemp('/tmp/orch-single-pane-tty-test-')
  try {
    const preloadPath = path.join(tmpDir, 'force-tty.ts')
    await fs.writeFile(preloadPath, 'process.stdout.isTTY = true\n')
    const proc = Bun.spawn(['bun', 'run', '--preload', preloadPath, ENTRY, ...argv], {
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

describe('CLI does not clear the user terminal on fast-error exit', () => {
  it('--mode=single-pane fails fast with the deferral message and writes nothing to stdout (no alt-screen-exit)', async () => {
    const { exitCode, stdout, stderr } = await runCliWithForcedTty([
      'run',
      'ask-demo',
      '--mode',
      'single-pane',
    ])

    expect(exitCode).toBe(EXIT_CONFIG_ERROR)
    expect(stderr).toContain('single-pane mode deferred')
    expect(stdout).not.toContain(ALT_SCREEN_EXIT)
    expect(stdout).toBe('')
  }, 10_000)

  it('--mode=plain runs against a missing config without leaking alt-screen-exit to stdout', async () => {
    // Plain mode never sets the modes that tmux leaks, so the backstop
    // should not emit anything on stdout. (The command itself fails for an
    // unrelated reason in this empty cwd — `runs` is a no-op listing that
    // exits 0; we use it because it doesn't need a workflow file.)
    const { stdout } = await runCliWithForcedTty(['runs', '--mode', 'plain'])

    expect(stdout).not.toContain(ALT_SCREEN_EXIT)
  }, 10_000)
})
