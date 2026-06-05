// Shared fixture for the relocated `right-pane-controller.test.ts` suite. The old
// single 700-line file is split (the repo caps test files at 600 lines) into
// `right-pane-controller-sources.test.ts` and `right-pane-controller-lifecycle.test.ts`;
// both build the controller the same way, so the construction lives here.

import { mkdtemp, rm } from 'node:fs/promises'
import type { StepName } from '../../../src/core/types.ts'
import { createRightPaneController } from '../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import { FakeTmuxService, paneId, socketName } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { type RunId, runId as toRunId } from '../../../src/state/index.ts'
import { bufferStream, makeStore } from './_support.ts'

export const RUN_ID: RunId = toRunId('r-2026-05-11-100000-pm')
export const RIGHT_PANE = paneId('%7')
export const LEFT_PANE = paneId('%0')
export const SOCKET = socketName('orch-main-test')

export const stepName = (s: string): StepName => s as StepName

export async function makeController(): Promise<{
  readonly tmux: FakeTmuxService
  readonly controller: ReturnType<typeof createRightPaneController>
  readonly tempDir: string
}> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const tempDir = await mkdtemp('/tmp/orch-pane-map-')
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
  return { tmux, controller, tempDir }
}

export async function cleanup(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true })
}
