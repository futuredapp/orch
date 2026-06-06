// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller-banner.test.ts (parent U7b)
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. This file asserts the controller's
// WIRE-FORMAT decision — the snapshot `emitBanner` / `setViewMode` /
// `dismiss-banner` write to the TUI overlay IPC channel. Distinct from the
// overlay *codec* parse/serialize tests (relocated in U10–U13): here we assert
// what the controller writes, not how the overlay (de)serializes it.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRightPaneController } from '../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import { parseTuiOverlayLine } from '../../../src/hosts/two-pane/steps-view/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { type RunId, runId as toRunId } from '../../../src/state/index.ts'
import { bufferStream, makeStore, readOverlayLines } from './_support.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-200000-pm')
const RIGHT_PANE = paneId('%7')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-test')

async function makeController(): Promise<{
  readonly controller: ReturnType<typeof createRightPaneController>
  readonly tempDir: string
  readonly overlayPath: string
}> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const tempDir = await mkdtemp('/tmp/orch-banner-')
  const overlayPath = `${tempDir}/tui-overlay.ndjson`
  const controller = createRightPaneController({
    tmux,
    socket: SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(RUN_ID, {}),
    runId: RUN_ID,
    stateDir: toPath(tempDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: bufferStream(),
    width: 200,
    height: 50,
    tuiOverlayPath: toPath(overlayPath),
  })
  return { controller, tempDir, overlayPath }
}

describe('right-pane-controller emitBanner', () => {
  it('writes a snapshot with a fresh monotonic seq on every call', async () => {
    const { controller, tempDir, overlayPath } = await makeController()
    try {
      await controller.emitBanner({ kind: 'info', text: 'first', ttlMs: 4000 })
      await controller.emitBanner({ kind: 'info', text: 'second', ttlMs: 4000 })
      await controller.emitBanner({ kind: 'error', text: 'third' })

      const lines = await readOverlayLines(overlayPath)
      expect(lines).toHaveLength(3)
      const parsed = lines.map(parseTuiOverlayLine)
      expect(parsed[0]?.banner?.seq).toBe(1)
      expect(parsed[1]?.banner?.seq).toBe(2)
      expect(parsed[2]?.banner?.seq).toBe(3)
      expect(parsed[0]?.banner?.text).toBe('first')
      expect(parsed[2]?.banner?.kind).toBe('error')
    } finally {
      await controller.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves the current view-mode across banner emits', async () => {
    const { controller, tempDir, overlayPath } = await makeController()
    try {
      await controller.setViewMode({ mode: 'replay', stepName: 'plan' })
      await controller.emitBanner({ kind: 'info', text: 'tick' })

      const lines = await readOverlayLines(overlayPath)
      const last = parseTuiOverlayLine(lines.at(-1) ?? '')
      expect(last?.view).toEqual({ mode: 'replay', stepName: 'plan' })
      expect(last?.banner?.text).toBe('tick')
    } finally {
      await controller.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('is a no-op (in-memory only, no write) when tuiOverlayPath is omitted', async () => {
    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const tempDir = await mkdtemp('/tmp/orch-banner-')
    try {
      const controller = createRightPaneController({
        tmux,
        socket: SOCKET,
        leftPaneId: LEFT_PANE,
        rightPaneId: RIGHT_PANE,
        paneQueue: queue,
        stateStore: makeStore(RUN_ID, {}),
        runId: RUN_ID,
        stateDir: toPath(tempDir),
        cwd: toPath(tempDir),
        env: {},
        stderr: bufferStream(),
        width: 200,
        height: 50,
      })

      // Should not throw, even without a configured overlay path.
      await controller.emitBanner({ kind: 'info', text: 'x' })

      const lines = await readOverlayLines(`${tempDir}/tui-overlay.ndjson`)
      expect(lines).toHaveLength(0)

      await controller.stop()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('right-pane-controller setViewMode', () => {
  it('writes a snapshot with the new view-mode and no banner change', async () => {
    const { controller, tempDir, overlayPath } = await makeController()
    try {
      await controller.setViewMode({ mode: 'replay', stepName: 'plan' })

      const lines = await readOverlayLines(overlayPath)
      const last = parseTuiOverlayLine(lines.at(-1) ?? '')
      expect(last?.view).toEqual({ mode: 'replay', stepName: 'plan' })
      expect(last?.banner).toBeUndefined()
    } finally {
      await controller.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('right-pane-controller dismiss-banner intent', () => {
  it('clears the in-memory banner and writes a snapshot with banner: null', async () => {
    const { controller, tempDir, overlayPath } = await makeController()
    try {
      await controller.emitBanner({ kind: 'error', text: 'oops' })
      controller.onIntent({ type: 'dismiss-banner' })
      // Give the async file write a beat.
      await new Promise((r) => setTimeout(r, 20))

      const lines = await readOverlayLines(overlayPath)
      expect(lines.length).toBeGreaterThan(1)
      const last = parseTuiOverlayLine(lines.at(-1) ?? '')
      expect(last?.banner).toBeUndefined()
    } finally {
      await controller.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('is a no-op when no banner is set', async () => {
    const { controller, tempDir, overlayPath } = await makeController()
    try {
      controller.onIntent({ type: 'dismiss-banner' })
      await new Promise((r) => setTimeout(r, 20))

      const lines = await readOverlayLines(overlayPath)
      expect(lines).toHaveLength(0)
    } finally {
      await controller.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
