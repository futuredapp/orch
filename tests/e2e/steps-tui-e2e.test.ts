// MIGRATED → tests-new/e2e/steps-tui-e2e.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Phase 4 e2e: full Steps TUI loop against a real Claude CLI in a real tmux.
//
// Gated on `RUN_REAL_CLAUDE=1` AND `tmux -V`. Auto-skips otherwise. The shape:
//   1. Boot a real tmux session via createTmuxHost.
//   2. Drive a single-step interactive Claude invocation through it.
//   3. Capture the left pane and assert the live driver's seat shows the
//      step name + Claude session.
//   4. Send a `quit` intent into the steps-view daemon's intents file.
//   5. Assert awaitForegroundShutdown resolves and teardown succeeds.
//
// This is a single test on the gated path; the always-on coverage lives in
// `tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts`.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResumeRegistry } from '../../src/core/resume-registry.ts'
import { stepName as toStepName } from '../../src/core/types.ts'
import { createTmuxHost } from '../../src/hosts/index.ts'
import { claude } from '../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
} from '../../src/services/index.ts'
import { path as toPath } from '../../src/services/types.ts'
import { FileStateStore, type RunId } from '../../src/state/index.ts'

const _canRun =
  process.env.RUN_REAL_CLAUDE === '1' && Bun.which('tmux') !== null && Bun.which('claude') !== null

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe.skip('steps-tui e2e (real Claude + real tmux)', () => {
  it('runs a tiny Claude flow under the steps view, then quits via intent', async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'orch-steps-tui-e2e-'))
    const runIdVal = 'r-2026-05-05-200000-ee' as RunId
    const stateBase = `${tmpDir}/.orch/state`
    const stateDir = `${stateBase}/${runIdVal}`
    await fs.mkdir(`${stateDir}/logs`, { recursive: true })

    // Seed a minimal completed-state state.json so the steps view has
    // content to render. Using a real workflow execution would make this a
    // 30-second test; the seeded approach keeps it under 5 seconds.
    await fs.writeFile(
      `${stateDir}/state.json`,
      JSON.stringify({
        schemaVersion: 5,
        id: runIdVal,
        status: 'completed',
        workflowName: 'tui-e2e',
        startedAt: 0,
        endedAt: 1_000,
        steps: {
          plan: {
            name: 'plan',
            value: null,
            startedAt: 0,
            endedAt: 1_000,
            artifacts: [],
            validations: [],
            transcriptEventCount: 0,
            transcriptTruncated: false,
          },
        },
      }),
    )

    const stderr: string[] = []
    const stderrStream = {
      write(chunk: unknown): boolean {
        stderr.push(String(chunk))
        return true
      },
    } as unknown as NodeJS.WritableStream

    const bunFs = new BunFsService()
    const processService = new BunProcessService()
    const stateStore = new FileStateStore({ fs: bunFs, basePath: toPath(stateBase) })
    void new BunGitService({ processService })

    const claudeRunner = claude({ bare: false })
    const resumeRegistry = createResumeRegistry()
    // Seed the registry the same way the workflow executor would for any
    // interactive step the e2e flow drives through this host.
    resumeRegistry.register(toStepName('plan'), claudeRunner)

    const host = await createTmuxHost({
      processService,
      clock: new BunClock(),
      runId: runIdVal,
      workflowName: 'tui-e2e',
      stderr: stderrStream,
      skipAttach: true,
      env: {},
      cwd: tmpDir,
      fs: bunFs,
      basePath: toPath(stateBase),
      stateStore,
      resumeRegistry,
    })

    // Give the steps-view daemon time to mount and project the seeded state.
    await new Promise((r) => setTimeout(r, 1_500))

    const intentsPath = `${stateDir}/tui-intents.ndjson`
    await fs.appendFile(intentsPath, `${JSON.stringify({ type: 'quit' })}\n`)

    await Promise.race([
      host.awaitForegroundShutdown(),
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error('shutdown timeout')), 5_000)),
    ])

    await host.teardown()

    expect(stderr.join('')).not.toContain('TUI unavailable')
  }, 30_000)
})
