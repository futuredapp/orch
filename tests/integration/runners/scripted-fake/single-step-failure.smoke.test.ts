/**
 * Smoke: a scripted `instant-fail` step drives the run to the `failed` state
 * end-to-end, in-process.
 *
 * The sibling `two-step-linear.smoke.test.ts` proves the happy path
 * (`instant-ok` → `completed`); this proves the failure path: the runner's
 * `__entry.ts` subprocess emits a terminal/error and exits non-zero, the
 * executor throws `StepError`, and the persisted `RunState.status` is `failed`
 * (the graceful step-failure bucket, NOT `crashed`).
 *
 * No Tier 5 subprocess — the fixture workflow runs directly with a real
 * `BunProcessService`, so the runner subprocess actually fires.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { createFakeHost } from '@orch/test/fake-host.ts'
import wf from '@orch/test/fixtures/lifecycle/single-agent-step.ts'
import { StepError } from '../../../../src/core/index.ts'
import {
  ORCH_LIFECYCLE_SCRIPT_ENV,
  type ScriptedFakeScriptFile,
} from '../../../../src/runners/scripted-fake/index.ts'
import {
  BunClock,
  BunFsService,
  BunProcessService,
  FakeGitService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'

const RUN_ID = 'r-2026-06-11-100000-f1' as RunId

let workDir: string
let priorScriptEnv: string | undefined

beforeEach(async () => {
  workDir = await mkdtemp(nodePath.join(tmpdir(), 'scripted-fake-failure-smoke-'))
  priorScriptEnv = process.env[ORCH_LIFECYCLE_SCRIPT_ENV]
})

afterEach(async () => {
  if (priorScriptEnv === undefined) {
    delete process.env[ORCH_LIFECYCLE_SCRIPT_ENV]
  } else {
    process.env[ORCH_LIFECYCLE_SCRIPT_ENV] = priorScriptEnv
  }
  await rm(workDir, { recursive: true, force: true })
})

describe('single-agent-step fixture scripted instant-fail (in-process smoke)', () => {
  it('persists the run as failed and surfaces a StepError carrying the simulated message', async () => {
    const script: ScriptedFakeScriptFile = {
      steps: {
        work: { kind: 'instant-fail', message: 'simulated failure: upstream API 400' },
      },
    }
    const scriptPath = nodePath.join(workDir, 'script.json')
    await writeFile(scriptPath, JSON.stringify(script), 'utf-8')
    process.env[ORCH_LIFECYCLE_SCRIPT_ENV] = scriptPath

    const fs = new BunFsService()
    const basePath = path(workDir)

    let caught: unknown
    try {
      await wf.execute({
        stateStore: new FileStateStore({ fs, basePath }),
        processService: new BunProcessService(),
        clock: new BunClock(),
        fsService: fs,
        gitService: new FakeGitService(),
        runId: RUN_ID,
        cwd: path(workDir),
        workflowName: wf.name,
        host: createFakeHost(),
        promptService: new FakePromptService(),
        interactivity: 'interactive',
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StepError)
    expect((caught as StepError).message).toContain('simulated failure: upstream API 400')

    const stateRaw = await readFile(`${workDir}/${RUN_ID}/state.json`, 'utf-8')
    const state = JSON.parse(stateRaw) as { readonly status: string }

    expect(state.status).toBe('failed')
  }, 30_000)
})
