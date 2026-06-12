/**
 * scroll-test — a dummy workflow that emits 60 instant steps to exercise
 * scrolling in the left (steps) pane, then parks on an ask() so the run stays
 * alive for manual inspection.
 *
 * Pipeline:
 *   1..60. step-NN   command (echo), instant, zero-token   → one steps-pane row each
 *   61.    park      ask, blocks until the user answers     → keeps the TUI running
 *
 * This is a throwaway TUI test harness — it spawns no agents and makes no API
 * calls. Every step is a `command()` running `echo`, so the 60 rows appear in
 * the steps pane essentially instantly and you can scroll through them.
 *
 * Usage:
 *   bunx orch run scroll-test
 *   (use --mode=two-pane to see the steps pane; the final ask() needs a TTY)
 */

import { ask, command, workflow } from 'orch'

const STEP_COUNT = 60

const PARK = ask({
  name: 'park',
  question: `All ${STEP_COUNT} steps completed — scroll the left pane to verify. Done?`,
  buttons: ['done'],
  defaultWhenNoninteractive: { button: 'done' },
})

export default workflow('scroll-test', async (run) => {
  for (let i = 1; i <= STEP_COUNT; i++) {
    const label = `step-${String(i).padStart(2, '0')}`
    const echoStep = command(label, {
      argv: ['echo', `${label} of ${STEP_COUNT}`],
      onFailure: 'halt',
    })
    await run(echoStep)
  }

  await run(PARK)
})
