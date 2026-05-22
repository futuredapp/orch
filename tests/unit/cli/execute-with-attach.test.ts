import { describe, expect, it } from 'bun:test'
import { executeWithAttach } from '../../../src/cli/commands/execute-with-attach.ts'
import { EXIT } from '../../../src/cli/main.ts'
import type { Host } from '../../../src/hosts/index.ts'

interface FakeHostState {
  readonly host: Host
  attachSettled: boolean
  teardownCalls: number
  resolveAttach: () => void
  setReachable: (reachable: boolean, reason?: string) => void
  probeCalls: number
}

function fakeHost(mode: Host['mode'] = 'plain'): FakeHostState {
  let resolveAttach!: () => void
  const attachPromise = new Promise<void>((resolve) => {
    resolveAttach = resolve
  })
  let reachable = true
  let reason: string | undefined
  const state: FakeHostState = {
    attachSettled: false,
    teardownCalls: 0,
    probeCalls: 0,
    resolveAttach: () => {
      state.attachSettled = true
      resolveAttach()
    },
    setReachable: (r, why) => {
      reachable = r
      reason = why
    },
    host: {
      mode,
      attachForeground: () => attachPromise,
      // Plain mode resolves immediately with `'attach-exited'`; two-pane
      // mirrors attachPromise and reports the same reason — the unit fake
      // does not exercise the `'quit'` branch (that's covered by the
      // integration cells under tests/integration/lifecycle/).
      awaitForegroundShutdown: () =>
        mode === 'plain'
          ? Promise.resolve('attach-exited' as const)
          : attachPromise.then(() => 'attach-exited' as const),
      probeReachability: async () => {
        state.probeCalls++
        return reachable ? { reachable: true } : { reachable: false, reason }
      },
      teardown: async () => {
        state.teardownCalls++
      },
      // Methods unused by executeWithAttach — never called in this test surface.
    } as unknown as Host,
  }
  // PlainHost auto-resolves attachForeground; emulate that.
  if (mode === 'plain') state.resolveAttach()
  return state
}

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = {
    write(chunk: unknown): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
  } as unknown as NodeJS.WritableStream
  return { stream, text: () => chunks.join('') }
}

describe('executeWithAttach (unit)', () => {
  it('writes the two-line success summary on the success path', async () => {
    const host = fakeHost()
    const stderr = bufferStream()

    const code = await executeWithAttach({
      host: host.host,
      workflow: Promise.resolve(),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
    })

    expect(code).toBe(EXIT.OK)
    expect(stderr.text()).toBe(
      'Workflow "demo" completed.\n  data: .orch/state/r-2026-04-29-143052-7k/\n',
    )
    expect(host.teardownCalls).toBe(1)
  })

  it('writes the two-line failure summary on a mapped failure', async () => {
    const host = fakeHost()
    const stderr = bufferStream()

    const code = await executeWithAttach({
      host: host.host,
      workflow: Promise.reject(new Error('step blew up')),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: (err) => ({ code: EXIT.STEP_FAILURE, reason: (err as Error).message }),
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(stderr.text()).toBe(
      'Workflow "demo" failed: step blew up\n  data: .orch/state/r-2026-04-29-143052-7k/\n',
    )
    expect(host.teardownCalls).toBe(1)
  })

  it('does not double-write the reason — mapError is side-effect free', async () => {
    const host = fakeHost()
    const stderr = bufferStream()

    await executeWithAttach({
      host: host.host,
      workflow: Promise.reject(new Error('boom')),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: (err) => ({ code: EXIT.STEP_FAILURE, reason: (err as Error).message }),
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
    })

    // The reason "boom" must appear exactly once in stderr.
    const text = stderr.text()
    const occurrences = text.split('boom').length - 1
    expect(occurrences).toBe(1)
  })

  it('two-pane: prints the detach hint when the host is still reachable after attach exits', async () => {
    const host = fakeHost('two-pane')
    const stderr = bufferStream()
    host.setReachable(true)

    // Workflow resolves on a macro-task tick so the foreground settlement
    // (microtask chain off the attach promise) wins the race deterministically.
    const workflow = new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })

    host.resolveAttach()

    const code = await executeWithAttach({
      host: host.host,
      workflow,
      runId: 'r-2026-05-22-093650-j0',
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'feature', runDir: '.orch/state/r-2026-05-22-093650-j0' },
    })

    expect(code).toBe(EXIT.OK)
    expect(host.probeCalls).toBe(1)
    const text = stderr.text()
    expect(text).toContain('detached. run continues in background')
    expect(text).toContain('re-attach with: tmux -L orch-r-2026-05-22-093650-j0')
  })

  it('two-pane: prints unreachable notice (NOT the detach hint) when probe fails after attach exits', async () => {
    const host = fakeHost('two-pane')
    const stderr = bufferStream()
    host.setReachable(false, 'tmux server is no longer reachable')

    // Workflow rejects on a macro-task tick — same ordering trick as above so
    // the foreground race winner is `attach-exited`, not the workflow's reject.
    const workflow = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error('tmux session is no longer reachable — cannot start step deepen')),
        10,
      )
    })

    host.resolveAttach()

    const code = await executeWithAttach({
      host: host.host,
      workflow,
      runId: 'r-2026-05-22-093650-j0',
      stderr: stderr.stream,
      mapError: (err) => ({ code: EXIT.STEP_FAILURE, reason: (err as Error).message }),
      summary: { workflowName: 'feature', runDir: '.orch/state/r-2026-05-22-093650-j0' },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(host.probeCalls).toBe(1)
    const text = stderr.text()
    expect(text).not.toContain('run continues in background')
    expect(text).not.toContain('re-attach with')
    expect(text).toContain('tmux server is no longer reachable')
  })

  it('re-throws when mapError returns undefined and writes no summary', async () => {
    const host = fakeHost()
    const stderr = bufferStream()
    const surprise = new Error('unmapped')

    let caught: unknown
    try {
      await executeWithAttach({
        host: host.host,
        workflow: Promise.reject(surprise),
        runId: 'r-2026-04-29-143052-7k',
        stderr: stderr.stream,
        mapError: () => undefined,
        summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(surprise)
    expect(stderr.text()).toBe('')
    expect(host.teardownCalls).toBe(1)
  })
})
