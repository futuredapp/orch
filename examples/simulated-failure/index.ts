/**
 * simulated-failure — DEV-ONLY example: a headless run that ends in the FAILED
 * state on purpose, so you can see what a failed run looks like end-to-end.
 *
 * One autonomous `scriptedFake` step (`crash`). Its behavior comes from a JSON
 * script the runner reads via the `ORCH_LIFECYCLE_SCRIPT` env var — the bundled
 * `script.json` scripts it as `instant-fail`, which emits a terminal/error and
 * exits non-zero. The executor turns that into a `StepError`, and the run lands
 * `failed` in `.orch/state/<runId>/state.json`.
 *
 * `scriptedFake` is a deep import on purpose (absent from the public barrels —
 * a dev/test-only affordance). Never ship this in a published config.
 *
 * Run it (the script path is required — the runner refuses to start without it):
 *
 *     ORCH_LIFECYCLE_SCRIPT=examples/simulated-failure/script.json \
 *       bunx orch run simulated-failure
 *
 * Then inspect the failed state:
 *
 *     cat .orch/state/<runId>/state.json | jq .status                 # "failed"
 *     cat .orch/state/<runId>/logs/agents/crash/raw_output.ndjson     # terminal/error
 *
 * See examples/simulated-failure/README.md.
 */

import { step, workflow } from '../../src/core/index.ts'
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'

const CRASH = step.define('crash', {
  agent: scriptedFake({ stepName: 'crash' }),
  prompt: 'simulated-failure: this step is scripted to fail (see script.json).',
})

export default workflow('simulated-failure', async (run) => {
  await run(CRASH, { as: 'crash' })
})
