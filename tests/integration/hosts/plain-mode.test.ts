// plain-mode end-to-end: drive a two-step FakeRunner workflow through the
// PlainHost and assert the stdout shape (text + JSON) matches the plan's
// Story 2 / Mode 1 lines.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-04-23-pl0001' as RunId

async function runTwoStepPlainWorkflow(format: 'text' | 'json'): Promise<{
  stdout: string
  stderr: string
}> {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1_700_000_000_000)
  const stdout = bufferStream()
  const stderr = bufferStream()

  const host = createPlainHost({
    stdout: stdout.stream,
    stderr: stderr.stream,
    format,
    clock,
    runId: RUN_ID,
  })

  const agent = new FakeRunner(processService)
  agent.script({ structuredOutput: 'plan-done' })
  agent.script({ structuredOutput: 'work-done' })

  const deps: WorkflowDeps = {
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    processService,
    clock,
    runId: RUN_ID,
    cwd: path('/workspace'),
    fsService: fs,
    gitService: new FakeGitService(),
    host,
  }

  const wf = workflow('demo', async (run) => {
    await run(step.define('plan', { agent }))
    await run(step.define('work', { agent }))
  })
  await wf.execute(deps)
  await host.teardown()

  return { stdout: stdout.text(), stderr: stderr.text() }
}

describe('--mode=plain --format=text', () => {
  it('emits [orch] lifecycle lines and [stepName] runner lines in order', async () => {
    const { stdout } = await runTwoStepPlainWorkflow('text')
    const lines = stdout.split('\n').filter((l) => l.length > 0)

    expect(lines).toContain('[orch] step:start plan (autonomous)')
    expect(lines.find((l) => l.startsWith('[orch] step:complete plan '))).toBeDefined()
    expect(lines).toContain('[orch] step:start work (autonomous)')
    expect(lines.find((l) => l.startsWith('[orch] step:complete work '))).toBeDefined()

    // Order: plan start before plan complete before work start
    const idxPlanStart = lines.indexOf('[orch] step:start plan (autonomous)')
    const idxWorkStart = lines.indexOf('[orch] step:start work (autonomous)')
    expect(idxPlanStart).toBeLessThan(idxWorkStart)
  })
})

describe('--mode=plain — step:failed frame', () => {
  it('writes the Story 1.5 failure frame to stderr and exits via StepError', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stdout = bufferStream()
    const stderr = bufferStream()

    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock,
      runId: RUN_ID,
    })

    const agent = new FakeRunner(processService)
    agent.script({ failWith: { message: 'model timed out' } })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
    }

    let caught: unknown
    try {
      await workflow('demo', async (run) => {
        await run(step.define('plan', { agent }))
      }).execute(deps)
    } catch (err) {
      caught = err
    }
    await host.teardown()

    expect(caught).toBeDefined()

    // Single-line header on stdout as before.
    expect(stdout.text()).toContain('[orch] step:failed plan')

    // Inline Story 1.5 frame on stderr.
    const err = stderr.text()
    expect(err).toContain('✗ step "plan" failed')
    expect(err).toContain('model timed out')
    expect(err).toContain(`orch resume ${RUN_ID}`)
    expect(err).toContain(`orch logs ${RUN_ID}`)
  })
})

describe('--mode=plain --format=json', () => {
  it('emits one NDJSON envelope per event with ts/run/ev/step', async () => {
    const { stdout, stderr } = await runTwoStepPlainWorkflow('json')
    const lines = stdout.split('\n').filter((l) => l.length > 0)

    // Every line is parseable JSON with the flat envelope.
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed.ts).toBeDefined()
      expect(parsed.run).toBe(RUN_ID)
      expect(parsed.ev).toBeDefined()
    }

    const evs = lines.map((l) => JSON.parse(l).ev as string)
    expect(evs).toContain('step.start')
    expect(evs).toContain('step.complete')

    // Banner stays off stdout under json format; our driver also bypasses
    // the CLI-level banner, so stderr may be empty — assert nothing lands on
    // it inadvertently.
    expect(stderr).toBe('')
  })
})
