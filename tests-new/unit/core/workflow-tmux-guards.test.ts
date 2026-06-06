// Host-seam forwarding — the executor no longer carries `onEvent` / `tmuxActive`
// callbacks; every runner event now travels through `host.onRunnerEvent`.
// This file used to pin the deleted tmuxActive interactive refusal; that guard
// moves to Phase B (view resolution) / Phase D (pane attach), so Phase A only
// verifies the host seam still hears every runner event for an autonomous step.

import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner, type RunnerEvent } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  clock?: FakeClock
  runId?: RunId
  host?: FakeHost
}): WorkflowDeps & { processService: FakeProcessService; clock: FakeClock; host: FakeHost } {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = overrides?.clock ?? new FakeClock(1000)
  const host = overrides?.host ?? createFakeHost()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-14-097860-gx'),
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

describe('host runner-event forwarding', () => {
  it('fires host.onRunnerEvent for every parsed runner event in order', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService)
    agent.script({
      events: [
        { kind: 'info', type: 'assistant', payload: { text: 'hello' } },
        { kind: 'info', type: 'tool-call', payload: { name: 'Write' } },
      ],
      structuredOutput: 'done',
    })

    const STEP = step.define('work', { agent })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const received: RunnerEvent[] = deps.host.recorded
      .filter((r) => r.kind === 'runner')
      .map((r) => (r as Extract<typeof r, { kind: 'runner' }>).event)
    expect(received.length).toBe(3)
    expect(received[0]).toMatchObject({ kind: 'info', type: 'assistant' })
    expect(received[1]).toMatchObject({ kind: 'info', type: 'tool-call' })
    expect(received[2]).toMatchObject({ kind: 'terminal', type: 'turn-complete' })
  })

  it('runs an autonomous step normally with a default host', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService)
    agent.script({ structuredOutput: 'ok' })

    const STEP = step.define('work', { agent })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('ok')
  })
})
