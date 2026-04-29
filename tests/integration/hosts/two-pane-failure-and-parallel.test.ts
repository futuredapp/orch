// Phase D2 integration coverage — drives the TmuxHost through the workflow
// executor for two scenarios:
//   - a failing autonomous step ends up rendering the Story 1.5 failure frame
//     on the right pane, and the run exits with a StepError.
//   - a homogeneous parallel() call emits step:parallel-branch-update events
//     that reach the right pane as a compact rollup.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import { StepError, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
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

function rightPayloads(tmux: FakeTmuxService, right: string): string[] {
  return tmux.recordedCalls
    .filter((c) => c.method === 'sendKeys' && c.opts.target === paneId(right))
    .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
}

describe('two-pane D2 — failing step', () => {
  it('renders the Story 1.5 failure frame on the right pane when an autonomous step fails', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const runId = 'r-2026-04-23-699656-8n' as RunId
    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
    })

    const agent = new FakeRunner(processService)
    agent.script({ failWith: { message: 'model timed out' } })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId,
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

    expect(caught).toBeInstanceOf(StepError)

    const right = rightPayloads(tmux, '%7').join('')
    expect(right).toContain('✗ step "plan" failed')
    expect(right).toContain('model timed out')
    expect(right).toContain(`orch resume ${runId}`)
    expect(right).toContain(`orch logs ${runId}`)
  })
})

describe('two-pane D2 — parallel rollup', () => {
  it('emits step:parallel-branch-update events that render as a compact rollup', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const runId = 'r-2026-04-23-423020-l8' as RunId
    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
    }

    await workflow('demo', async (run) => {
      // Homogeneous parallel — wraps each branch in the parallelDepth
      // execution context, so the executor emits parallel-branch-update
      // events we can assert on.
      await parallel(
        ['a', 'b'],
        (label) => {
          const fr = new FakeRunner(processService)
          fr.script({ structuredOutput: `ok-${label}` })
          const REVIEW = step.define('review', { agent: fr })
          return run(REVIEW, { as: `review-${label}` })
        },
        { concurrency: 2 },
      )
    }).execute(deps)
    await host.teardown()

    const right = rightPayloads(tmux, '%7').join('')
    expect(right).toContain('parallel branches:')
    // Both branches end up completed so the final rollup carries ✓ for each.
    expect(right).toContain('✓ review-a')
    expect(right).toContain('✓ review-b')
  })
})
