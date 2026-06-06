/**
 * Smoke: the `tier5-two-step-linear` fixture workflow runs end-to-end
 * in-process when both steps are scripted as `instant-ok`.
 *
 * No Tier 5 subprocess — we execute the fixture's workflow directly with a
 * minimal `WorkflowDeps` and a real `BunProcessService` (so the runner's
 * `__entry.ts` subprocess actually fires). This proves the fixture is wired
 * correctly before the U4 launcher boots it as a CLI subprocess.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
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
import wf from '@orch/test/fixtures/lifecycle/two-step-linear.ts'
import { createFakeHost } from '@orch/test/fake-host.ts'

const RUN_ID = 'r-2026-05-20-100000-t5' as RunId

let workDir: string
let priorScriptEnv: string | undefined

beforeEach(async () => {
  workDir = await mkdtemp(nodePath.join(tmpdir(), 'tier5-fixture-smoke-'))
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

describe('tier5-two-step-linear fixture (in-process smoke)', () => {
  it('runs both steps to completion when scripted as instant-ok × 2', async () => {
    const script: ScriptedFakeScriptFile = {
      steps: {
        plan: { kind: 'instant-ok', structuredOutput: { phase: 'plan-done' } },
        execute: { kind: 'instant-ok', structuredOutput: { phase: 'execute-done' } },
      },
    }
    const scriptPath = nodePath.join(workDir, 'script.json')
    await writeFile(scriptPath, JSON.stringify(script), 'utf-8')
    process.env[ORCH_LIFECYCLE_SCRIPT_ENV] = scriptPath

    const fs = new BunFsService()
    const basePath = path(workDir)

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

    const stateRaw = await readFile(`${workDir}/${RUN_ID}/state.json`, 'utf-8')
    const state = JSON.parse(stateRaw) as {
      readonly status: string
      readonly steps: Readonly<Record<string, { readonly value: unknown }>>
    }

    // RunState.status flips to 'completed' once both steps land their entries;
    // per-step "completed" is implicit (entry presence + value populated).
    expect(state.status).toBe('completed')
    expect(Object.keys(state.steps).sort()).toEqual(['execute', 'plan'])
    expect(state.steps.plan?.value).toEqual({ phase: 'plan-done' })
    expect(state.steps.execute?.value).toEqual({ phase: 'execute-done' })
  }, 30_000)
})
