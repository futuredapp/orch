// triage: rewrite — file-existence proxy for "the live pane shows content immediately". Tier 1 (autonomous-live-pane-shows-content) asserts the visible-pane outcome directly. Rewrite to keep only the "starting marker is the first byte" invariant Tier 1 does not pin.
// Regression test for "autonomous step's live pane stays blank for the entire
// run" — observed in `r-2026-05-11-163506-44`. The right pane is `tail -F` on
// `…/agents/<step>/formatted_output.ansi`; that file is lazily created by the
// FileSessionLogger's byte sink only on the first non-empty `tee.write`. For
// 20+ s after `step:start` the codex runner emits only info events whose
// transcript rendering is empty, so `tee.write` never fires, the file is
// never created, and `tail -F` waits forever on a missing path.
//
// The user navigates away inside that window; even after the file is finally
// created and grows, they're already on a different source. Net result: the
// running autonomous step's bytes never appear in the visible pane.
//
// Contract this test pins: as soon as the host receives a `step:start` for an
// autonomous step, the tee file at the resolved tee path MUST exist and have
// non-empty content. That guarantees `tail -F` shows something the moment it
// opens the file, regardless of how long the underlying runner takes to emit
// its first transcript-rendering event.
//
// The fix lives in `tmux-host.ts`'s `step:start` autonomous handler.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { stepName } from '../../../../src/core/types.ts'
import { createTmuxHost } from '../../../../src/hosts/index.ts'
import { createFileSessionLogger } from '../../../../src/observability/index.ts'
import {
  BunClock,
  BunFsService,
  FakeProcessService,
  type ProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../../src/services/tmux/index.ts'
import { runId as toRunId } from '../../../../src/state/index.ts'

const RUN_ID = toRunId('r-2026-05-11-200000-lp')

function makeStderr(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

async function waitForFile(absPath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await stat(absPath)
      if (s.size > 0) return true
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-live-pane-immediate-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('tmux-host — autonomous step:start writes a starting marker so the live pane is never blank', () => {
  it('creates the tee file with non-empty content before any runner events arrive, so tail -F has something to render immediately', async () => {
    // ----- Arrange -----
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const fs = new BunFsService()
    const clock = new BunClock()
    const basePath = path(join(tempDir, '.orch', 'state'))
    const logger = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath,
      debug: false,
    })

    const host = await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock,
      runId: RUN_ID,
      workflowName: 'codex-riddle-solver',
      stderr: makeStderr(),
      skipVersionCheck: true,
      disableStepsView: true,
      logger,
    })

    const expectedTeePath = join(
      tempDir,
      '.orch',
      'state',
      RUN_ID,
      'logs',
      'agents',
      'solve-riddle',
      'formatted_output.ansi',
    )

    // ----- Act -----
    host.onLifecycleEvent({
      type: 'step:start',
      stepName: stepName('solve-riddle'),
      mode: 'autonomous',
    })

    // ----- Assert -----
    // The tee file must exist with non-empty content within a short window —
    // even though no runner events have fired and the codex runner would take
    // 5–25 s to emit its first transcript-renderable token.
    const appeared = await waitForFile(expectedTeePath, 2000)
    expect(appeared).toBe(true)

    const body = await readFile(expectedTeePath, 'utf8')
    expect(body.length).toBeGreaterThan(0)
    // Pin one of the load-bearing properties of the marker: the step name is
    // present, so a user looking at the right pane immediately knows which
    // step is running, not just that *something* is happening.
    expect(body).toContain('solve-riddle')

    await logger.close()
    await host.teardown()
  })
})
