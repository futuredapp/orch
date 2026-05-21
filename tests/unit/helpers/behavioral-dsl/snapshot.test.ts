// Unit coverage for `snapshot(handle, probe)`. Uses fakes for the subprocess
// handle, tmux probe, and process service so the snapshot can be exercised
// without booting a real orch run.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import type { SpawnHandle } from '../../../../src/services/process/process-service.ts'
import { paneId } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type {
  ExternalTmuxProbe,
  ProbedPane,
} from '../../../helpers/behavioral-dsl/internal/external-tmux-probe.ts'
import type {
  OrchHandle,
  Socket,
} from '../../../helpers/behavioral-dsl/internal/lifecycle-handle.ts'
import {
  countAltScreen,
  countMouseTracking,
  type LifecycleSnapshot,
  snapshot,
} from '../../../helpers/behavioral-dsl/internal/snapshot.ts'

interface FakeProbeOptions {
  readonly hasServer?: boolean
  readonly hasSession?: boolean
  readonly leftPaneText?: string
  readonly rightPaneText?: string
  readonly leftFocused?: boolean
  readonly rightFocused?: boolean
  readonly panes?: readonly ProbedPane[]
}

function fakeProbe(opts: FakeProbeOptions = {}): ExternalTmuxProbe {
  return {
    hasSession: async () => opts.hasSession ?? true,
    hasServer: async () => opts.hasServer ?? true,
    killServer: async () => {},
    sendMouseEvent: async () => {},
    pressKeyInPane: async () => {},
    leftPaneId: async () => paneId('%0'),
    rightPaneId: async () => paneId('%1'),
    listPanes: async () =>
      opts.panes ?? [
        { id: paneId('%0'), dead: false },
        { id: paneId('%1'), dead: false },
      ],
    capturePaneText: async (pane) =>
      pane === 'left' ? (opts.leftPaneText ?? '') : (opts.rightPaneText ?? ''),
    isPaneFocused: async (pane) =>
      pane === 'left' ? (opts.leftFocused ?? true) : (opts.rightFocused ?? false),
  }
}

interface FakeHandleOptions {
  readonly stateBase: string
  readonly stdoutBytes?: Buffer
  readonly exitAfterMs?: number
  readonly exitCode?: number
}

function fakeHandle(opts: FakeHandleOptions): OrchHandle {
  let resolveWait: (val: { exitCode: number }) => void = () => {}
  const waitPromise = new Promise<{ exitCode: number }>((res) => {
    resolveWait = res
  })
  if (opts.exitAfterMs !== undefined) {
    setTimeout(() => resolveWait({ exitCode: opts.exitCode ?? 0 }), opts.exitAfterMs)
  }
  const subprocess: SpawnHandle = {
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    writeStdin: () => {},
    stdoutBytes: () => opts.stdoutBytes ?? Buffer.alloc(0),
    wait: () => waitPromise,
    kill: () => {
      // Mark exited as if killed by signal SIGINT (exit code 130) so exitedNormally() resolves correctly.
      resolveWait({ exitCode: 130 })
    },
  }
  return {
    runId: 'r-test' as ReturnType<typeof Object> as never,
    socket: 'orch-test' as Socket,
    stateBase: toPath(opts.stateBase),
    stateDir: toPath(opts.stateBase),
    workflowCwd: toPath(opts.stateBase),
    repoRoot: toPath(opts.stateBase),
    env: {},
    subprocess,
    agent: () => {
      throw new Error('snapshot unit test does not use agent()')
    },
    teardown: async () => {},
  }
}

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orch-snap-test-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
})

describe('snapshot(handle, probe)', () => {
  it('reports tmuxServerExists=false and an empty pane state when the probe says the server is down', async () => {
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe({ hasServer: false })

    const snap = await snapshot(handle, probe)

    expect(snap.tmuxServerExists).toBe(false)
    expect(snap.tmuxSessionExists).toBe(false)
    expect(snap.leftPaneText).toBe('')
    expect(snap.panesAlive).toEqual([])
  })

  it('captures pane text and focus from the probe when the session is up', async () => {
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe({
      leftPaneText: 'plan output here',
      rightPaneText: 'live agent transcript',
      leftFocused: true,
      rightFocused: false,
    })

    const snap = await snapshot(handle, probe)

    expect(snap.leftPaneText).toBe('plan output here')
    expect(snap.rightPaneText).toBe('live agent transcript')
    expect(snap.leftPaneFocused).toBe(true)
    expect(snap.rightPaneFocused).toBe(false)
    expect(snap.panesAlive.length).toBe(2)
  })

  it('reports orchAlive=true when the wait() promise has not yet resolved', async () => {
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.orchAlive).toBe(true)
    expect(snap.orchExit).toBeNull()
  })

  it('latches orchExit with code and inferred signal when wait() resolves', async () => {
    const handle = fakeHandle({ stateBase: scratch, exitAfterMs: 0, exitCode: 130 })
    const probe = fakeProbe()

    await new Promise((r) => setTimeout(r, 10)) // let exit latch
    const snap = await snapshot(handle, probe)

    expect(snap.orchAlive).toBe(false)
    expect(snap.orchExit?.code).toBe(130)
    expect(snap.orchExit?.signal).toBe('SIGINT')
  })

  it('reads stateStatus and stepStatuses from state.json under stateDir', async () => {
    const stateJson = JSON.stringify({
      schemaVersion: 5,
      id: 'r-test',
      status: 'running',
      startedAt: 0,
      steps: { plan: { value: undefined } },
    })
    await writeFile(join(scratch, 'state.json'), stateJson, 'utf-8')
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.stateStatus).toBe('running')
    expect(snap.stepStatuses.plan).toBe('unknown') // entry exists but value undefined → mid-flight
  })

  it('reports stateStatus=unknown when state.json is missing', async () => {
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.stateStatus).toBe('unknown')
    expect(snap.stepStatuses).toEqual({})
  })

  it('flags perStepFilesIntact=false when a formatted_output file lacks a trailing newline', async () => {
    const stateJson = JSON.stringify({
      schemaVersion: 5,
      id: 'r-test',
      status: 'running',
      startedAt: 0,
      steps: {
        plan: {
          value: 'ok',
          startedAt: 0,
          endedAt: 0,
          artifacts: [],
          validations: [],
          transcriptEventCount: 0,
          transcriptTruncated: false,
        },
      },
    })
    await writeFile(join(scratch, 'state.json'), stateJson, 'utf-8')
    await mkdir(join(scratch, 'agents', 'plan'), { recursive: true })
    await writeFile(
      join(scratch, 'agents', 'plan', 'formatted_output.ansi'),
      'no trailing newline',
      'utf-8',
    )

    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.perStepFilesIntact.plan).toBe(false)
  })

  it('reports perStepFilesIntact=true for steps with no on-disk file yet', async () => {
    const stateJson = JSON.stringify({
      schemaVersion: 5,
      id: 'r-test',
      status: 'running',
      startedAt: 0,
      steps: { plan: { value: 'ok' } },
    })
    await writeFile(join(scratch, 'state.json'), stateJson, 'utf-8')
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.perStepFilesIntact.plan).toBe(true)
  })

  it('counts cumulative alt-screen and mouse-tracking escapes from stdout bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from('hello'),
      Buffer.from('\x1b[?1049h'),
      Buffer.from('\x1b[?1000h'),
      Buffer.from('\x1b[?1003h'),
      Buffer.from('mid'),
      Buffer.from('\x1b[?1000l'),
      Buffer.from('\x1b[?1003l'),
      Buffer.from('\x1b[?1049l'),
    ])
    const handle = fakeHandle({ stateBase: scratch, stdoutBytes: bytes })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.stdoutAltScreen).toEqual({ enters: 1, exits: 1 })
    expect(snap.stdoutMouseTracking).toEqual({ ons: 2, offs: 2 })
  })

  it('returns an empty orphanChildren list when orchPid is omitted', async () => {
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe)

    expect(snap.orphanChildren).toEqual([])
  })

  it('sweeps grandchildren (not direct children) of orch via recursive pgrep', async () => {
    // Direct children of orch are part of orch's expected tree (tmux, runner).
    // The orphan sweep records grandchildren and deeper — processes that
    // escaped orch's lifecycle and need to be flagged for cleanup.
    const processService = new FakeProcessService()
    processService
      .when(['pgrep', '-P', '111', '-l'])
      .respondWith({ exitCode: 0, stdout: ['222 sleep', '333 cat'] })
    processService.when(['pgrep', '-P', '222', '-l']).respondWith({ exitCode: 1, stdout: [] })
    processService
      .when(['pgrep', '-P', '333', '-l'])
      .respondWith({ exitCode: 0, stdout: ['444 echo'] })
    processService.when(['pgrep', '-P', '444', '-l']).respondWith({ exitCode: 1, stdout: [] })

    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap = await snapshot(handle, probe, { processService, orchPid: 111 })

    const pids = snap.orphanChildren.map((c) => c.pid).sort((a, b) => a - b)
    expect(pids).toEqual([444])
    expect(snap.orphanChildren[0]?.ppid).toBe(333)
  })

  it('stamps capturedAtMs and orchAliveDurationMs derived from the supplied clock', async () => {
    let nowVal = 1_000_000
    const clock = {
      now: () => nowVal,
      sleep: async () => {},
    }
    const handle = fakeHandle({ stateBase: scratch })
    const probe = fakeProbe()

    const snap1 = await snapshot(handle, probe, { clock, spawnedAtMs: 1_000_000 })
    nowVal = 1_002_500
    const snap2 = await snapshot(handle, probe, { clock, spawnedAtMs: 1_000_000 })

    expect(snap1.capturedAtMs).toBe(1_000_000)
    expect(snap1.orchAliveDurationMs).toBe(0)
    expect(snap2.capturedAtMs).toBe(1_002_500)
    expect(snap2.orchAliveDurationMs).toBe(2_500)
  })
})

describe('countAltScreen / countMouseTracking helpers', () => {
  it('returns zero counts for an empty buffer', () => {
    expect(countAltScreen(Buffer.alloc(0))).toEqual({ enters: 0, exits: 0 })
    expect(countMouseTracking(Buffer.alloc(0))).toEqual({ ons: 0, offs: 0 })
  })

  it('counts each escape sequence exactly once even when adjacent to other bytes', () => {
    const bytes = Buffer.from('x\x1b[?1049hxx\x1b[?1049lyy\x1b[?1049hzz')
    expect(countAltScreen(bytes)).toEqual({ enters: 2, exits: 1 })
  })

  it('treats \\x1b[?1000h and \\x1b[?1003h as equivalent mouse-on markers', () => {
    const bytes = Buffer.concat([
      Buffer.from('\x1b[?1000h'),
      Buffer.from('\x1b[?1003h'),
      Buffer.from('\x1b[?1003l'),
    ])
    expect(countMouseTracking(bytes)).toEqual({ ons: 2, offs: 1 })
  })
})

// Suppress unused-locals warning by referencing the type — the snapshot's
// LifecycleSnapshot is what the assertions consume; we want a typed handle
// here as a compile-time check.
const _typecheck: LifecycleSnapshot | undefined = undefined
void _typecheck
