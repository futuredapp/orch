// U4 — autonomous session persistence. The executor mints a fresh session id
// per produce-body invocation and propagates it into the autonomous runner
// context (mirroring the interactive path), so a persisted session has a known
// checkpoint id to fork from. Asserts via a recording runner that captures
// `ctx.sessionId` at buildCommand time.

import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId

function makeDeps(extras: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-06-02-110000-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...extras,
  }
}

/** A runner that records the `sessionId` it sees in every buildCommand call. */
function recordingRunner(
  deps: WorkflowDeps,
  name: string,
  sink: Array<string | undefined>,
): Runner {
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 40; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  return defineRunner({
    name,
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      sink.push(ctx.sessionId)
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return 'ok'
    },
    toTranscriptLines() {
      return []
    },
  })
}

describe('autonomous session id propagation (U4)', () => {
  it('propagates the injected generateSessionId into the autonomous runner context', async () => {
    const seen: Array<string | undefined> = []
    const fixed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const deps = makeDeps({ generateSessionId: () => fixed })
    const WORK = step.define('work', { agent: recordingRunner(deps, 'r1', seen), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await run(WORK)
    })
    await wf.execute(deps)

    expect(seen).toEqual([fixed])
  })

  it('mints a fresh id per produce-body invocation by default (no reuse across steps)', async () => {
    const seen: Array<string | undefined> = []
    const deps = makeDeps()
    const A = step.define('a', { agent: recordingRunner(deps, 'ra', seen), prompt: 'x' })
    const B = step.define('b', { agent: recordingRunner(deps, 'rb', seen), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await run(A)
      await run(B)
    })
    await wf.execute(deps)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeDefined()
    expect(seen[1]).toBeDefined()
    expect(seen[0]).not.toBe(seen[1])
  })
})
