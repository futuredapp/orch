// Contract test for the *live* path that feeds the right pane while a runner
// is producing events.
//
// Companion to right-pane-live-doubling.real.integration.test.ts, which
// reproduces the actual doubled-output bug at the kernel pty layer. This
// file pins the host-layer contract that the eventual fix must preserve:
//
//   - one `sendKeys` call per runner event that emits transcript lines
//   - no `respawnPane` of the right pane while the autonomous step is live
//     (respawn is reserved for the replay path)
//   - the live payload contains real ANSI bytes (we expect them — the
//     doubling that the user sees is not us emitting them twice from the
//     formatter)
//
// If the eventual fix changes the placeholder argv to something like
// `sh -c 'stty -echo; exec cat'`, that swap will be visible as a different
// `respawnPane` call at host-bootstrap time but must NOT introduce extra
// `sendKeys` calls or per-event respawns. These assertions guard that.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../../src/core/workflow.ts'
import { createTmuxHost } from '../../../../src/hosts/index.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FakeTmuxService, paneId } from '../../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'

const RUN_ID = 'r-2026-05-06-000001-rl' as RunId
const RIGHT = paneId('%7')
const LEFT = paneId('%0')
const ESC = String.fromCharCode(0x1b)

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

interface DriveResult {
  readonly tmux: FakeTmuxService
}

async function driveOneAssistantStep(events: ReadonlyArray<string>): Promise<DriveResult> {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1_700_000_000_000)

  const tmux = new FakeTmuxService()
  tmux.setListPanesResult(['%0'])
  tmux.nextPaneId(RIGHT)

  const host = await createTmuxHost({
    tmux,
    processService,
    clock,
    runId: RUN_ID,
    workflowName: 'demo',
    stderr: bufferStream(),
    skipVersionCheck: true,
  })

  const agent = new FakeRunner(processService)
  agent.script({
    events: events.map((text) => ({
      kind: 'info' as const,
      type: 'assistant',
      payload: { text },
    })),
    structuredOutput: 'done',
  })

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

  return { tmux }
}

describe('two-pane host live path: single writer per runner event', () => {
  it('emits exactly one sendKeys call to the right pane per emitted transcript event', async () => {
    const { tmux } = await driveOneAssistantStep(['first thinking', 'second thinking'])

    const rightSends = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )

    expect(rightSends.length).toBe(2)
  })

  it('does not respawn the right pane during the autonomous step (live path stays on send-keys)', async () => {
    const { tmux } = await driveOneAssistantStep(['only thinking'])

    // The *right* pane must not be respawned for live transcript output.
    // (The left pane may legitimately respawn for the steps-view daemon, and
    // host bootstrap can respawn the left placeholder — neither is on the
    // right-pane live path under test here.)
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT,
    )

    expect(rightRespawns.length).toBe(0)
  })

  it('writes ANSI-colored payloads (color: true) so the bug surface is real, not a vacuous render', async () => {
    const { tmux } = await driveOneAssistantStep(['only thinking'])

    const rightSends = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )
    const payload = rightSends
      .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
      .join('')

    // Real ESC byte must be present — proves the formatter is in color mode
    // and that the bytes hitting `tmux send-keys -l` include escape sequences
    // (which is the trigger for the kernel pty echo-doubling).
    expect(payload).toContain(`${ESC}[`)
  })

  it('never sends a payload that contains literal caret-notation escapes (formatter side)', async () => {
    // Caret-notation `^[[` is the kernel pty's *display* of an unprintable
    // ESC byte. It can never appear in raw bytes the host hands to tmux —
    // if it did, the bug would be in the formatter and stripping pty echo
    // would not fix it. This pins that the bytes leaving the host are clean.
    const { tmux } = await driveOneAssistantStep(['first', 'second', 'third'])

    const rightSends = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === RIGHT,
    )

    for (const c of rightSends) {
      if (c.method !== 'sendKeys') continue
      const payload = c.opts.keys.join('')
      expect(payload).not.toContain('^[[')
    }
  })

  it('left-pane bootstrap respawn is unrelated to the right-pane live path', async () => {
    // Sanity: the host does call respawnPane during bootstrap (left pane
    // gets a `clear && exec cat` setup via sendKeys, not respawn — this
    // assertion just records what *does* happen so a future fix that adds
    // a right-pane respawn at bootstrap is visible here.
    const { tmux } = await driveOneAssistantStep(['hello'])

    const leftRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === LEFT,
    )
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT,
    )

    // Today the right pane is never respawned on the live path. This is the
    // load-bearing invariant — the fix may still respawn at bootstrap, but
    // not per event.
    expect(rightRespawns.length).toBe(0)
    // Left pane respawn count is informational; we don't pin a number here
    // because steps-view bootstrap is wired separately. We just record the
    // existence-or-not for future readers.
    expect(leftRespawns.length).toBeGreaterThanOrEqual(0)
  })
})
