/**
 * command-demo — runs an arbitrary shell command as a first-class workflow
 * step. Watch stdout/stderr stream live into the active host pane.
 *
 * The first step runs `bun --version` so the demo works without Claude/Codex
 * configured. The second step runs `sh -c` to demonstrate stderr capture and
 * the `tail()` helper for trimming captured output. Both use
 * `onFailure: 'continue'` so the workflow keeps going even if a command exits
 * non-zero — the result holds the exit code for the workflow to inspect.
 *
 * Usage:
 *   bunx orch run command-demo
 *   bunx orch run command-demo --mode=two-pane   # output streams in the right pane
 */

import { command, tail, workflow } from '../../src/core/index.ts'

export default workflow('command-demo', async (run) => {
  const VERSION = command('bun-version', {
    argv: ['bun', '--version'],
    onFailure: 'continue',
  })

  const NOISY = command('noisy', {
    argv: [
      '/bin/sh',
      '-c',
      'for i in 1 2 3 4 5 6 7 8; do printf "line-%s\\n" "$i"; done; printf "warn\\n" 1>&2; exit 0',
    ],
    onFailure: 'continue',
  })

  const v = await run(VERSION)
  console.log(`[command-demo] bun version → ${v.stdout.trim()} (exit ${v.exitCode})`)

  const n = await run(NOISY)
  console.log(`[command-demo] noisy exit=${n.exitCode} duration=${n.durationMs}ms`)
  console.log('[command-demo] last 3 stdout lines:')
  console.log(tail(n.stdout, 3))
  console.log('[command-demo] stderr:', n.stderr.trim())
})
