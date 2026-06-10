import { describe, expect, it } from 'bun:test'
import { executeWithAttach } from '../../../src/cli/commands/execute-with-attach.ts'
import { EXIT } from '../../../src/cli/main.ts'
import type { ForegroundShutdownReason, Host } from '../../../src/hosts/index.ts'

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

  it('two-pane: when attach exits to an unreachable host, fails on host loss instead of continuing to a later interactive step', async () => {
    const host = fakeHost('two-pane')
    const stderr = bufferStream()
    host.setReachable(false, 'tmux server is no longer reachable')

    // Mirrors the user-visible sequence from r-2026-05-25-085934-pd:
    // the attach client reports host loss while the workflow is still doing
    // autonomous work, and only later would the workflow hit an ask() step.
    // The launcher behavior we want is to fail at the host-loss boundary,
    // not let that later ask() become the primary failure message.
    const workflow = new Promise<void>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              'tmux session is no longer reachable — interactive step play-again-1 cannot continue',
            ),
          ),
        10,
      )
    })

    host.resolveAttach()

    const code = await executeWithAttach({
      host: host.host,
      workflow,
      runId: 'r-2026-05-25-085934-pd',
      stderr: stderr.stream,
      mapError: (err) => ({ code: EXIT.STEP_FAILURE, reason: (err as Error).message }),
      summary: { workflowName: 'tic-tac-toe', runDir: '.orch/state/r-2026-05-25-085934-pd' },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(host.probeCalls).toBe(1)
    expect(host.teardownCalls).toBe(1)

    const text = stderr.text()
    expect(text).toContain('Workflow "tic-tac-toe" failed: tmux server is no longer reachable')
    expect(text).not.toContain('interactive step play-again-1 cannot continue')
    expect(text).not.toContain('run continues in background')
    expect(text).not.toContain('re-attach with')
  })

  it('renders a crash summary and exits STEP_FAILURE when mapError returns undefined (never re-throws into the silent backstop)', async () => {
    const host = fakeHost()
    const stderr = bufferStream()
    // A plain Error a workflow body throws before any step runs — e.g. an
    // arg-validation guard. mapError has no domain mapping for it. Before the
    // fix this re-threw, became an unhandled rejection, and the tmux host's
    // backstop swallowed it to lifecycle.ndjson — the user saw nothing.
    const surprise = new Error('file-prompts-demo requires a prompt')

    const code = await executeWithAttach({
      host: host.host,
      workflow: Promise.reject(surprise),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(stderr.text()).toBe(
      'Workflow "demo" crashed: file-prompts-demo requires a prompt\n' +
        '  data: .orch/state/r-2026-04-29-143052-7k/\n',
    )
    expect(host.teardownCalls).toBe(1)
  })

  it('read-only: a decided [r]/[c] action survives a teardown failure (callback fires before teardown)', async () => {
    // Regression for L2: the read-only branch used to `await host.teardown()`
    // BEFORE invoking `onReadOnlyShutdown`. If teardown threw (tmux socket gone
    // mid-command) the callback never fired, openFailed's captured action stayed
    // undefined, and a decided retry/continue was misread as `dismissed`.
    const stderr = bufferStream()
    let teardownCalls = 0
    let received: ForegroundShutdownReason | undefined
    const host = {
      mode: 'two-pane' as const,
      attachForeground: () => Promise.resolve(),
      awaitForegroundShutdown: () => Promise.resolve({ type: 'action', action: 'retry' } as const),
      teardown: async () => {
        teardownCalls++
        throw new Error('tmux socket gone mid-command')
      },
    } as unknown as Host

    const code = await executeWithAttach({
      host,
      workflow: Promise.resolve(),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
      readOnly: true,
      onReadOnlyShutdown: (reason) => {
        received = reason
      },
    })

    expect(received).toEqual({ type: 'action', action: 'retry' })
    expect(teardownCalls).toBe(1)
    expect(code).toBe(EXIT.OK)
  })

  it('crash summary uses String(reason) when a non-Error is thrown', async () => {
    const host = fakeHost()
    const stderr = bufferStream()

    const code = await executeWithAttach({
      host: host.host,
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      workflow: Promise.reject('bare string boom'),
      runId: 'r-2026-04-29-143052-7k',
      stderr: stderr.stream,
      mapError: () => undefined,
      summary: { workflowName: 'demo', runDir: '.orch/state/r-2026-04-29-143052-7k' },
    })

    expect(code).toBe(EXIT.STEP_FAILURE)
    expect(stderr.text()).toBe(
      'Workflow "demo" crashed: bare string boom\n' +
        '  data: .orch/state/r-2026-04-29-143052-7k/\n',
    )
    expect(host.teardownCalls).toBe(1)
  })
})
