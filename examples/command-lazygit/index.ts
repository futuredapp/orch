/**
 * command-tick-demo — exercises live streaming of `command()` output by
 * spawning a tiny shell loop that prints one line every second. Useful as a
 * sanity check that stdout is rendered as it's produced (not buffered until
 * the process exits) and that the captured `stdout` string contains every
 * line you saw on the host pane.
 *
 * The command emits 10 ticks, one per second, so the whole run takes ~10s.
 * Use `--mode=two-pane` to see the stream land in the right pane.
 *
 * Usage:
 *   bunx orch run command-tick-demo
 *   bunx orch run command-tick-demo --mode=two-pane
 */

import { command, workflow } from '../../src/core/index.ts'

const LAZYGIT = command('lazygit', {
  argv: [
    'lazygit',
  ],
  onFailure: 'continue',
})

export default workflow('command-lazygit', async (run) => {
  const result = await run(LAZYGIT)
  console.log(`[command-lazygit] exit=${result.exitCode} duration=${result.durationMs}ms`)
})
