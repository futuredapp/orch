// Unit tests for TmuxHost.attachForeground and the nested-tmux guard. Drives
// the host with a FakeTmuxService + FakeProcessService and asserts the
// spawnForeground argv and teardown-aware exit handling.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { createTmuxHost, HostCreationError } from '../../../src/hosts/index.ts'
import { FakeClock, FakeProcessService, type ProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import type { RunId } from '../../../src/state/index.ts'

function makeStderr(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-04-23-700304-kl' as RunId

async function buildHostWithAttach(opts?: {
  skipAttach?: boolean
  env?: Record<string, string | undefined>
}) {
  const tmux = new FakeTmuxService()
  tmux.setListPanesResult(['%0'])
  tmux.nextPaneId(paneId('%1'))
  const processService = new FakeProcessService()
  const stderr = makeStderr()
  const host = await createTmuxHost({
    tmux,
    processService: processService as ProcessService,
    clock: new FakeClock(0),
    runId: RUN_ID,
    workflowName: 'compound',
    stderr: stderr.stream,
    skipVersionCheck: true,
    env: opts?.env ?? {},
    cwd: '/tmp',
    ...(opts?.skipAttach !== undefined ? { skipAttach: opts.skipAttach } : {}),
  })
  return { host, tmux, processService, stderr }
}

describe('TmuxHost.attachForeground', () => {
  it('composes tmux -L <socket> attach-session -t <session> via spawnForeground', async () => {
    const { host, processService } = await buildHostWithAttach()
    const expectedArgv = ['tmux', '-L', `orch-${RUN_ID}`, 'attach-session', '-t', 'orch']
    processService.whenForeground(expectedArgv).respondWith({ exitCode: 0 })

    await host.attachForeground()
    await host.teardown()
  })

  it('resolves when the attach subprocess exits cleanly', async () => {
    const { host, processService } = await buildHostWithAttach()
    processService
      .whenForeground(['tmux', '-L', `orch-${RUN_ID}`, 'attach-session', '-t', 'orch'])
      .respondWith({ exitCode: 0 })

    await expect(host.attachForeground()).resolves.toBeUndefined()
    await host.teardown()
  })

  it('resolves silently when teardown already triggered the attach exit', async () => {
    const { host, processService, stderr } = await buildHostWithAttach()
    // Kill-session teardown typically makes tmux clients exit 1. This must
    // not surface an error because it's the expected clean-exit path.
    processService
      .whenForeground(['tmux', '-L', `orch-${RUN_ID}`, 'attach-session', '-t', 'orch'])
      .respondWith({ exitCode: 1 })

    // Simulate the race: teardown fires first; attach exits with non-zero.
    await host.teardown()
    await host.attachForeground()

    expect(stderr.text()).not.toContain('attach exited with code')
  })

  it('writes a diagnostic to stderr when exit is non-zero and teardown did not fire', async () => {
    const { host, processService, stderr } = await buildHostWithAttach()
    processService
      .whenForeground(['tmux', '-L', `orch-${RUN_ID}`, 'attach-session', '-t', 'orch'])
      .respondWith({ exitCode: 5 })

    await host.attachForeground()

    expect(stderr.text()).toContain('[orch tmux] attach exited with code 5')
    await host.teardown()
  })

  it('is a no-op that never spawns when skipAttach is true', async () => {
    const { host, processService, stderr } = await buildHostWithAttach({ skipAttach: true })

    // No scripted response queued — if the host spawns anything, it throws.
    await expect(host.attachForeground()).resolves.toBeUndefined()
    // And the old hint-only banner is preserved under --no-attach.
    expect(stderr.text()).toContain('attach with:')
    expect(stderr.text()).toContain('clean up with:')

    // Sanity: ProcessService was never asked for a foreground spawn.
    expect(() =>
      processService.spawnForeground({
        argv: ['never'],
        env: {},
        cwd: '/tmp' as unknown as Parameters<typeof processService.spawnForeground>[0]['cwd'],
      }),
    ).toThrow()

    await host.teardown()
  })
})

describe('createTmuxHost — nested-tmux guard', () => {
  it('throws HostCreationError with the nested-tmux guidance when $TMUX is non-empty', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const stderr = makeStderr()

    let caught: unknown
    try {
      await createTmuxHost({
        tmux,
        processService: new FakeProcessService() as ProcessService,
        clock: new FakeClock(0),
        runId: RUN_ID,
        workflowName: 'compound',
        stderr: stderr.stream,
        skipVersionCheck: true,
        env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(HostCreationError)
    const msg = (caught as Error).message
    expect(msg).toContain('already inside a tmux session')
    expect(msg).toContain('--mode=plain')
  })

  it('skips the guard when $TMUX is set but skipAttach is true (headless attach is a no-op)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const stderr = makeStderr()

    // --no-attach inside a nested tmux is legitimate: the CLI never spawns
    // attach-session, so there is no client-routing ambiguity to protect
    // against. Host creation must succeed.
    const host = await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: RUN_ID,
      workflowName: 'compound',
      stderr: stderr.stream,
      skipVersionCheck: true,
      env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      skipAttach: true,
    })

    expect(host.mode).toBe('two-pane')
    await host.teardown()
  })
})
