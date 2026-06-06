// MIGRATED → tests-new/integration/services/prompt/ink-prompt-service-real.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Layer-3 integration test for the InkPromptService child process.
// ---------------------------------------------------------------------------
//
// Gated on `RUN_INK_REAL=1` because actually rendering Ink requires a real
// PTY: with piped stdin (Bun.spawn default), Ink's `useFocus` detects
// `isRawModeSupported === false` and never registers a 'readable' listener
// — the child mounts but ignores all keystrokes and never exits.
//
// The arg-parse cases below run cleanly with piped stdio because the
// runner exits before Ink ever mounts. The full Ink-render smoke test
// requires a PTY harness (e.g. BSD `script -q /dev/null bun test ...`)
// and is gated separately on `RUN_INK_TTY=1`.

const RUN_REAL = process.env.RUN_INK_REAL === '1'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(here, '..', '..', '..', '..')
const RUNNER = join(REPO_ROOT, 'src', 'services', 'prompt', 'ink-runner.ts')

describe.skip('InkPromptService — real spawn', () => {
  it('exits non-zero when invoked with no args (arg-parse boundary)', async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, RUNNER],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  })

  it('exits non-zero when --spec is missing', async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, RUNNER, '--result', '/tmp/orch-ask-noop.json'],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  })

  // Full Ink-render smoke test — only meaningful under a PTY harness.
  // Documented here as a reference for manual verification:
  //
  //   RUN_INK_REAL=1 RUN_INK_TTY=1 script -q /dev/null \
  //     bun test tests/integration/services/prompt/ink-prompt-service-real.test.ts
  //
  // With a real PTY, ink-text-input + useFocus settle, and writing '\r' to
  // stdin resolves the prompt with the first button.
  it.skipIf(process.env.RUN_INK_TTY !== '1')(
    'renders, accepts Enter on the first button, and writes the result file',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orch-ask-real-'))
      const resultPath = join(dir, 'result.json')
      const spec = {
        question: 'continue?',
        fields: [],
        buttons: ['continue', 'cancel'],
      }
      const specB64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64')

      const proc = Bun.spawn({
        cmd: [process.execPath, RUNNER, '--spec', specB64, '--result', resultPath],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Hit Enter on the first auto-focused button after Ink has had a
      // moment to mount and enable raw mode.
      setTimeout(() => {
        proc.stdin.write('\r')
        proc.stdin.end()
      }, 500)

      const exitCode = await proc.exited
      expect(exitCode).toBe(0)

      const body = await readFile(resultPath, 'utf8')
      const parsed = JSON.parse(body) as { cancelled: boolean; button?: string }
      expect(parsed.cancelled).toBe(false)
      expect(parsed.button).toBe('continue')
    },
  )
})
