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

import { command, workflow } from 'orch'

const TICK_COUNT = 10

const TICKS = command('ticks', {
  argv: [
    '/bin/sh',
    '-c',
    `i=1; n=${TICK_COUNT}; while [ $i -le $n ]; do printf "tick %s/%s @ %s\\n" "$i" "$n" "$(date +%H:%M:%S)"; sleep 1; i=$((i+1)); done`,
  ],
  onFailure: 'halt',
})

export default workflow('command-tick-demo', async (run) => {
  console.log(`[command-tick-demo] streaming ${TICK_COUNT} ticks (one per second)…`)
  const result = await run(TICKS)
  const lineCount = result.stdout.trimEnd().split('\n').filter(Boolean).length
  console.log(
    `[command-tick-demo] done — exit=${result.exitCode} duration=${result.durationMs}ms lines=${lineCount}`,
  )
})
