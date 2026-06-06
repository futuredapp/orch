// COVERED BY → tests-new/unit/core/command.test.ts (parent U14 group-B closeout) — unit behavior covered; end-to-end real-tmux/host assertion dropped (no faithful fake substrate, P14-D5); see ledger. Kept skipped on disk (D2).
/**
 * Behavioral cell — a `command(...)` step's stdout streams to the right pane
 * and the captured `CommandResult` lands in `state.json` with `exitCode: 0`.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  awaitRunStatus,
  awaitStepStatus,
  fileContains,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

describe.skip('Tier 5 behavioral — command step streams + records', () => {
  it('command stdout streams to disk and state.json records exitCode 0', async () => {
    handle = await launchOrchWorkflow('command-step-only', {
      script: { hold: puppet() },
    })

    await awaitStepStatus('command:echo', 'completed', { timeoutMs: 15_000 })

    // Command stdout is fanned out to the right pane in real time AND captured
    // to `<stateDir>/logs/commands/<step>/stdout.log` by `runCommandStep`
    // (src/core/command.ts:309). The pane rendering is covered at Tier 1; we
    // assert the durable on-disk capture instead, which makes the cell
    // stable against live-focus moving on to the next step.
    const stdoutLog = nodePath.join(
      handle.stateDir,
      'logs',
      'commands',
      'command:echo',
      'stdout.log',
    )
    await assertFilesystem(withinMs(5_000), fileContains(stdoutLog, 'orch-d14-marker'))

    await handle.agent('hold').complete()
    await awaitRunStatus('completed', { timeoutMs: 10_000 })

    // exitCode is captured in the per-step CommandResult value persisted to
    // state.json. We read state.json directly — the snapshot reader only
    // tracks endedAt presence, not value contents.
    const stateFile = nodePath.join(handle.stateDir, 'state.json')
    const raw = await Bun.file(stateFile).text()
    const parsed = JSON.parse(raw) as {
      steps?: Record<string, { value?: { exitCode?: number } }>
    }
    const stepEntry = parsed.steps?.['command:echo']
    if (stepEntry === undefined) {
      throw new Error(
        `expected steps["command:echo"] in state.json, got keys: ${Object.keys(parsed.steps ?? {}).join(', ')}`,
      )
    }
    const exitCode = stepEntry.value?.exitCode
    if (exitCode !== 0) {
      throw new Error(`expected exitCode 0, got ${exitCode}`)
    }
  }, 30_000)
})
