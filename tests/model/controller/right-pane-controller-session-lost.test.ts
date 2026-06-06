// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller-session-lost.test.ts (parent U7b)
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. Error-containment DECISIONS.
//
// Regression coverage for the tmux-server-death failure mode observed in run
// r-2026-05-22-093650-j0: after a long interactive step, the tmux server died
// externally. The next host call into the right-pane controller hit a socket
// that no longer existed and surfaced "error connecting to .../orch-X (No
// such file or directory)" from EVERY subsequent tmux call.
//
// The controller's contract under that condition:
//   1. It surfaces the failure (no swallowing) so the host can classify it.
//   2. It does NOT bleed any of the failures into opts.stderr (Bug B contract).
//   3. After the failure, the pane map does not retain a ghost entry.
//   4. The lifecycle log records the failure once with the canonical error shape.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { StepName } from '../../../src/core/types.ts'
import { createRightPaneController } from '../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import {
  FakeTmuxService,
  paneId,
  socketName,
  TmuxCommandError,
} from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { type RunId, type StepEntry, runId as toRunId } from '../../../src/state/index.ts'
import { type CapturingStderr, capturingStderr, flush, makeStore } from './_support.ts'

const RUN_ID: RunId = toRunId('r-2026-05-22-093650-j0')
const RIGHT_PANE = paneId('%1')
const LEFT_PANE = paneId('%0')
// Per-source sessions and `orch` share the per-run socket.
const SOCKET = socketName('orch-main-sl')

const stepName = (s: string): StepName => s as StepName

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-session-lost-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

interface Harness {
  readonly tmux: FakeTmuxService
  readonly stderr: CapturingStderr
  readonly overlayPath: string
  readonly controller: ReturnType<typeof createRightPaneController>
}

async function makeHarness(steps: Record<string, StepEntry>): Promise<Harness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const stderr = capturingStderr()
  const overlayPath = `${tempDir}/tui-overlay.ndjson`
  const controller = createRightPaneController({
    tmux,
    socket: SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(RUN_ID, steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: stderr.stream,
    width: 200,
    height: 50,
    tuiOverlayPath: toPath(overlayPath),
  })
  return { tmux, stderr, overlayPath, controller }
}

const SESSION_LOST_PATTERN = /no such file or directory|error connecting to/i

describe('right-pane-controller — tmux server lost mid-run', () => {
  it('registerSource for an interactive source throws when the socket is lost, with no stderr bleed', async () => {
    const h = await makeHarness({})

    // Server dies between host construction and the next interactive step.
    h.tmux.markSocketLost(SOCKET)

    let caught: unknown
    try {
      await h.controller.registerSource(
        { type: 'interactive', stepName: stepName('deepen-brainstorm') },
        {
          kind: 'pty',
          argv: ['claude', '--print'],
          env: {},
          cwd: toPath(tempDir),
        },
      )
    } catch (err) {
      caught = err
    }

    // Failure surfaced (caller — tmux-host — will translate via isSessionLostError).
    expect(caught).toBeInstanceOf(TmuxCommandError)
    expect((caught as TmuxCommandError).stderr).toMatch(SESSION_LOST_PATTERN)

    // No stderr bleed (Bug B contract).
    expect(h.stderr.chunks.join('')).toBe('')

    await h.controller.stop()
  })

  it('a session-lost registerSource leaves no ghost entry in the pane map', async () => {
    const h = await makeHarness({})

    h.tmux.markSocketLost(SOCKET)

    await h.controller
      .registerSource(
        { type: 'interactive', stepName: stepName('deepen-brainstorm') },
        {
          kind: 'pty',
          argv: ['claude', '--print'],
          env: {},
          cwd: toPath(tempDir),
        },
      )
      .catch(() => {
        /* expected */
      })
    await flush()

    // A re-register attempt would re-issue createSession (which still throws)
    // rather than hitting the "skip-existing" short-circuit. We model that as a
    // second attempt that also throws — and assert no pane id is silently held.
    let secondCaught: unknown
    try {
      await h.controller.registerSource(
        { type: 'interactive', stepName: stepName('deepen-brainstorm') },
        {
          kind: 'pty',
          argv: ['claude', '--print'],
          env: {},
          cwd: toPath(tempDir),
        },
      )
    } catch (err) {
      secondCaught = err
    }
    expect(secondCaught).toBeInstanceOf(TmuxCommandError)

    // Two createSession attempts were recorded (the second was not skipped
    // as "existing" — i.e. no ghost entry).
    const creates = h.tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(creates.length).toBeGreaterThanOrEqual(2)

    // And still no stderr bleed across the two attempts.
    expect(h.stderr.chunks.join('')).toBe('')

    await h.controller.stop()
  })

  it('unregisterSource after the server has died does not write to stderr', async () => {
    const h = await makeHarness({})

    // Register an interactive source successfully (server alive).
    h.tmux.nextCreateSessionPaneId(paneId('%50'))
    await h.controller.registerSource(
      { type: 'interactive', stepName: stepName('brainstorm') },
      {
        kind: 'pty',
        argv: ['claude', '--print'],
        env: {},
        cwd: toPath(tempDir),
      },
    )
    await flush()

    // Now the server dies — per-source sessions and `orch` share one socket
    // in the per-source design, so a single `markSocketLost` reaches both.
    h.tmux.markSocketLost(SOCKET)

    // Trying to unregister surfaces the session-lost error. The test does not
    // pin which sub-call throws; it pins the user-visible contract: no stderr bleed.
    await h.controller
      .unregisterSource({ type: 'interactive', stepName: stepName('brainstorm') })
      .catch(() => {
        /* expected — caller wraps via isSessionLostError */
      })
    await flush()

    expect(h.stderr.chunks.join('')).toBe('')

    await h.controller.stop()
  })

  it('FakeTmuxService.markSocketLost produces the canonical macOS error shape', async () => {
    // Adapter-shape pin: every test in this file relies on `markSocketLost`
    // producing an error whose stderr matches the session-lost pattern.
    const tmux = new FakeTmuxService()
    tmux.markSocketLost(SOCKET)

    let caught: unknown
    try {
      await tmux.createSession({
        socket: SOCKET,
        session: 'orch-src-x',
        width: 80,
        height: 24,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TmuxCommandError)
    const stderr = (caught as TmuxCommandError).stderr
    expect(stderr).toMatch(/error connecting to/)
    expect(stderr).toMatch(/No such file or directory/)
    expect(stderr).toContain(String(SOCKET))
  })
})
