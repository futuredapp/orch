// MIGRATED → tests-new/unit/hosts/host-registry.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Regression test for the right-pane-controller wiring: the `HostFactoryInputs`
// contract must include `stateStore`, otherwise the two-pane factory has no
// way to thread it into `createTmuxHost` and Enter-to-inspect intents are
// silently dropped (a real bug we hit on 2026-05-06).

import { afterEach, describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { createResumeRegistry } from '../../../src/core/resume-registry.ts'
import type { HostFactoryInputs, RegisterBuiltinHostsDeps } from '../../../src/hosts/index.ts'
import { createHostRegistry, registerBuiltinHosts } from '../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import { toClaudeTranscriptLines } from '../../../src/runners/index.ts'
import { FakeClock, FakeProcessService, type ProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import {
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  runId as toRunId,
} from '../../../src/state/index.ts'

function makeNoopStateStore(rid: RunId): StateStore {
  const empty: RunState = {
    schemaVersion: 5,
    id: rid,
    status: 'running',
    workflowName: 'demo',
    startedAt: 0,
    steps: {},
  }
  return {
    loadRun: async () => empty,
    saveStep: async () => {
      throw new Error('not implemented')
    },
    initRun: async () => {
      throw new Error('not implemented')
    },
    setStatus: async () => {
      throw new Error('not implemented')
    },
    setArgs: async (_rid: RunId, _args: PersistedWorkflowArgs) => {
      throw new Error('not implemented')
    },
    runDir: (rid) => `/runs/${rid}` as ReturnType<StateStore['runDir']>,
  }
}

describe.skip('HostFactoryInputs contract', () => {
  it('accepts a `stateStore` field — required by the two-pane right-pane controller', () => {
    const rid = toRunId('r-2026-05-06-200000-a1')
    // Compile-time guarantee: this assignment fails to type-check if
    // `stateStore` is not part of `HostFactoryInputs`. The runtime check
    // is a redundancy guard — the value of this test is the field's
    // presence in the type.
    const inputs: HostFactoryInputs = {
      runId: rid,
      workflowName: 'demo',
      stdout: process.stdout,
      stderr: process.stderr,
      clock: new FakeClock(0),
      logger: createNullSessionLogger({ runId: rid }),
      stateStore: makeNoopStateStore(rid),
    }

    expect(inputs.stateStore).toBeDefined()
  })
})

describe.skip('RegisterBuiltinHostsDeps.tmuxOverrides contract', () => {
  it('accepts a `transcriptRenderer` field — required for formatted ⏎ inspect on completed steps', () => {
    // Compile-time guarantee: this assignment fails to type-check if
    // `transcriptRenderer` is not part of `TmuxHostOptions` (and thus the
    // `tmuxOverrides` Omit). Mirrors the `stateStore` regression test
    // above. The value of this test is the field's presence in the type.
    const deps: RegisterBuiltinHostsDeps = {
      processService: {} as unknown as RegisterBuiltinHostsDeps['processService'],
      format: 'text',
      tmuxOverrides: {
        transcriptRenderer: toClaudeTranscriptLines,
      },
    }

    expect(deps.tmuxOverrides?.transcriptRenderer).toBe(toClaudeTranscriptLines)
  })
})

describe.skip('HostFactoryInputs.resumeRegistry contract', () => {
  it('accepts a `resumeRegistry` field — same live reference the workflow executor receives', () => {
    const rid = toRunId('r-2026-05-13-200000-a2')
    const resumeRegistry = createResumeRegistry()

    // Compile-time guarantee: the assignment fails to type-check if
    // `resumeRegistry` is not part of `HostFactoryInputs`. Mirrors the
    // `stateStore` regression — the right-pane controller has no way to
    // resolve a runner on Enter without this field reaching the host.
    const inputs: HostFactoryInputs = {
      runId: rid,
      workflowName: 'demo',
      stdout: process.stdout,
      stderr: process.stderr,
      clock: new FakeClock(0),
      logger: createNullSessionLogger({ runId: rid }),
      stateStore: makeNoopStateStore(rid),
      resumeRegistry,
    }

    expect(inputs.resumeRegistry).toBe(resumeRegistry)
  })
})

describe.skip('two-pane ORCH_TMUX_SOCKET bridge', () => {
  const ENV_KEY = 'ORCH_TMUX_SOCKET'
  const originalEnv = process.env[ENV_KEY]

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalEnv
  })

  function nullStream(): NodeJS.WritableStream {
    return new Writable({ write: (_c, _e, cb) => cb() }) as unknown as NodeJS.WritableStream
  }

  // Drives the real two-pane factory against a FakeTmuxService (injected via
  // tmuxOverrides) so we read the socket the factory resolved without booting a
  // real tmux server. No module mocking — the seam is the `tmux` port.
  async function resolveTwoPaneSocket(): Promise<string[]> {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const registry = createHostRegistry()
    registerBuiltinHosts(registry, {
      processService: new FakeProcessService() as ProcessService,
      format: 'text',
      tmuxOverrides: {
        tmux,
        skipVersionCheck: true,
        disableStepsView: true,
        skipAttach: true,
        installExitHandler: () => {},
        installRejectionHandler: () => {},
      },
    })

    await registry.resolve('two-pane')({
      runId: toRunId('r-2026-06-02-101010-z9'),
      workflowName: 'demo',
      stdout: nullStream(),
      stderr: nullStream(),
      clock: new FakeClock(0),
    })

    const sockets = new Set<string>()
    for (const call of tmux.recordedCalls) {
      const socket = (call.opts as { socket?: unknown }).socket
      if (typeof socket === 'string') sockets.add(socket)
    }
    return [...sockets]
  }

  it('passes the env socket into createTmuxHost when ORCH_TMUX_SOCKET is set', async () => {
    process.env[ENV_KEY] = 'orch-test-12345-abcd'

    expect(await resolveTwoPaneSocket()).toEqual(['orch-test-12345-abcd'])
  })

  it('derives orch-${runId} when ORCH_TMUX_SOCKET is unset (production default)', async () => {
    delete process.env[ENV_KEY]

    expect(await resolveTwoPaneSocket()).toEqual(['orch-r-2026-06-02-101010-z9'])
  })

  it('derives orch-${runId} when ORCH_TMUX_SOCKET is empty', async () => {
    process.env[ENV_KEY] = ''

    expect(await resolveTwoPaneSocket()).toEqual(['orch-r-2026-06-02-101010-z9'])
  })

  it('throws at the socketName smart constructor for a malformed ORCH_TMUX_SOCKET', async () => {
    process.env[ENV_KEY] = 'orch_BAD'

    await expect(resolveTwoPaneSocket()).rejects.toThrow(/invalid socket/)
  })
})
