// MIGRATED → tests-new/integration/hosts/two-pane/two-pane-mocked.test.ts
// two-pane-mocked: drive a two-step FakeRunner workflow through the TmuxHost
// backed by FakeTmuxService. Asserts the recorded tmux command stream never
// contains raw JSON on the right pane and that status frames land on the left.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createTmuxHost, stripAnsi } from '../../../src/hosts/index.ts'
import { createFileSessionLogger } from '../../../src/observability/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId, runId as runIdFactory } from '../../../src/state/index.ts'

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

const RUN_ID = 'r-2026-04-23-489539-t7' as RunId

describe.skip('two-pane mocked workflow', () => {
  it('streams readable transcript bytes through the per-step tee (U5: no right-pane sendKeys for transcripts)', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const basePath = path('/state')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const logger = createFileSessionLogger({ fs, clock, runId: RUN_ID, basePath, debug: false })

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
      logger,
    })

    const planAgent = new FakeRunner(processService)
    planAgent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan thinking' } }],
      structuredOutput: 'plan-done',
    })
    const workAgent = new FakeRunner(processService)
    workAgent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'work thinking' } }],
      structuredOutput: 'work-done',
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent: planAgent }))
      await run(step.define('work', { agent: workAgent }))
    }).execute(deps)
    await host.teardown()
    await logger.close()

    // U5 invariant: runner-event bytes do not go through sendKeys on the
    // visible right pane. They flow through the per-step tee; the file-
    // tail hidden pane mirrors them into the visible slot via swap-pane.
    const rightTranscriptWrites = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%7'),
    )
    expect(rightTranscriptWrites).toHaveLength(0)

    // The tee captures the transcript bytes for both steps.
    const planTxt = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/plan/formatted_output.txt`),
    )
    const workTxt = await fs.readFile(
      path(`${basePath}/${RUN_ID}/logs/agents/work/formatted_output.txt`),
    )
    expect(planTxt).toContain('[plan] assistant> plan thinking')
    expect(workTxt).toContain('[work] assistant> work thinking')
  })

  it('left pane is no longer painted by startStatusLoop (steps-view daemon owns it)', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
      // Steps-view daemon disabled — `basePath` is unset and the spawn would
      // need a real bun child anyway. The deletion-verification assertion
      // below proves no `startStatusLoop` writes reach the left pane.
    })

    const agent = new FakeRunner(processService)
    agent.script({ structuredOutput: 'plan-done' })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
    }).execute(deps)
    await host.teardown()

    const leftWrites = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%0'),
    )
    // The only sendKeys to %0 is the initial `clear && exec cat` setup. With
    // startStatusLoop removed, no rollup frames land on the left pane.
    expect(leftWrites.length).toBe(1)
    const onlyWrite = leftWrites[0]?.method === 'sendKeys' ? leftWrites[0].opts.keys.join('') : ''
    expect(onlyWrite).toContain('clear && exec cat')
  })

  it('persists rendered transcript bytes to agents/<step>/formatted_output.{ansi,txt}', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const basePath = path('/state')
    const teeRunId = runIdFactory('r-2026-04-28-000001-tp')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const logger = createFileSessionLogger({
      fs,
      clock,
      runId: teeRunId,
      basePath,
      debug: false,
    })

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: teeRunId,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
      logger,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan thinking' } }],
      structuredOutput: 'plan-done',
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath }),
      processService,
      clock,
      runId: teeRunId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
    }).execute(deps)
    await host.teardown()
    await logger.close()

    const ansi = await fs.readFile(
      path(`${basePath}/${teeRunId}/logs/agents/plan/formatted_output.ansi`),
    )
    const txt = await fs.readFile(
      path(`${basePath}/${teeRunId}/logs/agents/plan/formatted_output.txt`),
    )

    // tmux always renders with color so ANSI carries escapes; stripping
    // gives the same bytes as the txt sibling.
    expect(stripAnsi(ansi)).toBe(txt)
    expect(txt).toContain('[plan]')
    expect(txt).toContain('plan thinking')
    // tmux uses CRLF line endings on the right pane; the per-step file
    // mirrors the bytes the host emitted.
    expect(ansi).toContain('\r\n')

    // U5: the tee is the canonical sink for transcript bytes; no sendKeys
    // round-trip onto the visible right pane. The file-tail pane in scratch
    // mirrors the tee into the visible slot via swap-pane.
    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%7'),
    )
    expect(rightSendKeys).toHaveLength(0)
  })

  it('captures workflow-body console.log between steps instead of leaking it to tmux', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const stdout = bufferStream().stream
    ;(stdout as NodeJS.WritableStream & { isTTY?: boolean }).isTTY = true
    const basePath = path('/state')
    const stdioRunId = runIdFactory('r-2026-05-04-000001-so')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const logger = createFileSessionLogger({
      fs,
      clock,
      runId: stdioRunId,
      basePath,
      debug: false,
    })

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: stdioRunId,
      workflowName: 'demo',
      stderr: stderr.stream,
      stdout,
      skipVersionCheck: true,
      logger,
    })

    const planAgent = new FakeRunner(processService)
    planAgent.script({ structuredOutput: 'plan-done' })
    const workAgent = new FakeRunner(processService)
    workAgent.script({ structuredOutput: 'work-done' })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath }),
      processService,
      clock,
      runId: stdioRunId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    try {
      await workflow('demo', async (run) => {
        await run(step.define('plan', { agent: planAgent }))
        // biome-ignore lint/suspicious/noConsole: regression covers workflow-body console output
        console.log('WORKFLOW_BODY_LOG', { exitCode: 0 })
        await run(step.define('work', { agent: workAgent }))
      }).execute(deps)
    } finally {
      await host.teardown()
      await logger.close()
    }

    const tmuxPayloads = tmux.recordedCalls
      .filter((c) => c.method === 'sendKeys')
      .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
      .join('')
    expect(tmuxPayloads).not.toContain('WORKFLOW_BODY_LOG')

    const captured = await fs.readFile(path(`${basePath}/${stdioRunId}/logs/orch-stdio.log`))
    expect(captured).toContain('[stdout] WORKFLOW_BODY_LOG { exitCode: 0 }')
  })
})
