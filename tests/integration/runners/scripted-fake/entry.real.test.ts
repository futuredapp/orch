// MIGRATED → tests-new/integration/runners/scripted-fake/entry.real.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
/**
 * Integration: exercise `src/runners/scripted-fake/__entry.ts` as a real
 * subprocess via `BunProcessService.spawn` for every `StepScript` variant.
 *
 * This is the layer that proves the cross-process script-loading + dispatch
 * actually works end-to-end. Unit tests cover the loader and runner adapter
 * in isolation; here the entry script runs for real and we read its stdout.
 *
 * No mocks — `bun` and `BunProcessService` are real edges. Mirrors the
 * Tier 5 launcher's drive shape from the consumer side.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  ORCH_LIFECYCLE_SCRIPT_ENV,
  type ScriptedFakeScriptFile,
  scriptedFake,
} from '../../../../src/runners/scripted-fake/index.ts'
import type { RunnerEvent } from '../../../../src/runners/types.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import { path } from '../../../../src/services/types.ts'

const REPO_ROOT = nodePath.resolve(import.meta.dir, '../../../..')

async function makeWorkDir(): Promise<string> {
  return mkdtemp(nodePath.join(tmpdir(), 'scripted-fake-entry-'))
}

async function writeScript(dir: string, file: ScriptedFakeScriptFile): Promise<string> {
  const scriptPath = nodePath.join(dir, 'script.json')
  await writeFile(scriptPath, JSON.stringify(file), 'utf-8')
  return scriptPath
}

interface DriveResult {
  readonly events: readonly RunnerEvent[]
  readonly exitCode: number
}

async function driveEntry(stepName: string, scriptPath: string, cwd: string): Promise<DriveResult> {
  const ps = new BunProcessService()
  const runner = scriptedFake({ stepName })
  const cmd = runner.buildCommand({
    cwd: path(cwd),
    env: {
      [ORCH_LIFECYCLE_SCRIPT_ENV]: scriptPath,
      // PATH/HOME passthrough so `bun` resolves the entry's imports.
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    prompt: 'noop',
    extraArgs: [],
  })

  const handle = ps.spawn({ argv: cmd.argv, env: cmd.env, cwd: path(REPO_ROOT) })
  const events: RunnerEvent[] = []

  // Drain stderr concurrently to prevent pipe backpressure (CLAUDE.md note).
  const stderrDone = (async () => {
    for await (const _ of handle.stderr) {
      /* drain */
    }
  })()

  for await (const line of handle.stdout) {
    const evt = runner.parseEvents(line)
    if (evt !== null) events.push(evt)
  }

  const { exitCode } = await handle.wait()
  await stderrDone
  return { events, exitCode }
}

let workDir: string

beforeEach(async () => {
  workDir = await makeWorkDir()
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe.skip('scripted-fake __entry.ts (real subprocess)', () => {
  it('emits a turn-complete event and exits 0 for an instant-ok step', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: { plan: { kind: 'instant-ok' } },
    })

    const { events, exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(events).toEqual([{ kind: 'terminal', type: 'turn-complete' }])
    expect(exitCode).toBe(0)
  })

  it('emits scripted info events in order followed by turn-complete', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: {
        plan: {
          kind: 'instant-ok',
          events: [
            { kind: 'info', type: 'thinking', payload: { text: 'hmm' } },
            { kind: 'info', type: 'tool-call', payload: { name: 'read' } },
          ],
        },
      },
    })

    const { events, exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(events).toEqual([
      { kind: 'info', type: 'thinking', payload: { text: 'hmm' } },
      { kind: 'info', type: 'tool-call', payload: { name: 'read' } },
      { kind: 'terminal', type: 'turn-complete' },
    ])
    expect(exitCode).toBe(0)
  })

  it('attaches structuredOutput to the turn-complete event when set', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: {
        plan: {
          kind: 'instant-ok',
          structuredOutput: { score: 42 },
        },
      },
    })

    const { events, exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(events).toEqual([{ kind: 'terminal', type: 'turn-complete', data: { score: 42 } }])
    expect(exitCode).toBe(0)
  })

  it('emits a terminal/error event and exits non-zero for instant-fail', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: { plan: { kind: 'instant-fail', message: 'kaboom', exitCode: 7 } },
    })

    const { events, exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(events).toEqual([{ kind: 'terminal', type: 'error', message: 'kaboom' }])
    expect(exitCode).toBe(7)
  })

  it('defaults instant-fail to exit code 1 when not specified', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: { plan: { kind: 'instant-fail', message: 'boom' } },
    })

    const { exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(exitCode).toBe(1)
  })

  it('blocks on wait-for-file until the gate file exists, then proceeds', async () => {
    const gatePath = nodePath.join(workDir, 'plan.gate')
    const scriptPath = await writeScript(workDir, {
      steps: {
        plan: {
          kind: 'wait-for-file',
          gatePath,
          pollIntervalMs: 10,
          events: [{ kind: 'info', type: 'thinking', payload: { text: 'released' } }],
        },
      },
    })

    // Drive in background; release the gate after a short delay.
    const drivePromise = driveEntry('plan', scriptPath, workDir)
    setTimeout(() => {
      void writeFile(gatePath, '').catch(() => {})
    }, 50)

    const { events, exitCode } = await drivePromise

    expect(events).toEqual([
      { kind: 'info', type: 'thinking', payload: { text: 'released' } },
      { kind: 'terminal', type: 'turn-complete' },
    ])
    expect(exitCode).toBe(0)
  })

  it('emits-then-hangs until killed and never produces a terminal event', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: {
        plan: {
          kind: 'emit-then-hang',
          events: [{ kind: 'info', type: 'thinking', payload: { text: 'still here' } }],
        },
      },
    })

    const ps = new BunProcessService()
    const runner = scriptedFake({ stepName: 'plan' })
    const cmd = runner.buildCommand({
      cwd: path(workDir),
      env: {
        [ORCH_LIFECYCLE_SCRIPT_ENV]: scriptPath,
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      prompt: 'noop',
      extraArgs: [],
    })
    const handle = ps.spawn({ argv: cmd.argv, env: cmd.env, cwd: path(REPO_ROOT) })

    const stderrDone = (async () => {
      for await (const _ of handle.stderr) {
        /* drain */
      }
    })()

    // Read the first emitted info event, then kill — the hang means the
    // for-await won't terminate on its own.
    const reader = handle.stdout[Symbol.asyncIterator]()
    const first = await reader.next()
    expect(first.done).toBe(false)
    const parsed = runner.parseEvents(first.value as string)
    expect(parsed).toEqual({ kind: 'info', type: 'thinking', payload: { text: 'still here' } })

    handle.kill('SIGTERM')

    const { exitCode } = await handle.wait()
    await stderrDone
    expect(exitCode).not.toBe(0)
  })

  it('reports a clear error and exits 1 when ORCH_LIFECYCLE_SCRIPT is unset', async () => {
    const ps = new BunProcessService()
    const runner = scriptedFake({ stepName: 'plan' })
    const cmd = runner.buildCommand({
      cwd: path(workDir),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      prompt: 'noop',
      extraArgs: [],
    })
    const handle = ps.spawn({ argv: cmd.argv, env: cmd.env, cwd: path(REPO_ROOT) })

    const stderrDone = (async () => {
      for await (const _ of handle.stderr) {
        /* drain */
      }
    })()

    const events: RunnerEvent[] = []
    for await (const line of handle.stdout) {
      const evt = runner.parseEvents(line)
      if (evt !== null) events.push(evt)
    }
    const { exitCode } = await handle.wait()
    await stderrDone

    expect(events).toHaveLength(1)
    const evt = events[0]
    expect(evt?.kind).toBe('terminal')
    expect((evt as { type: string }).type).toBe('error')
    expect(exitCode).toBe(1)
  })

  it('reports a clear error when the step name is missing from the script', async () => {
    const scriptPath = await writeScript(workDir, {
      steps: { other: { kind: 'instant-ok' } },
    })

    const { events, exitCode } = await driveEntry('plan', scriptPath, workDir)

    expect(events).toHaveLength(1)
    const evt = events[0]
    expect(evt?.kind).toBe('terminal')
    expect((evt as { type: string }).type).toBe('error')
    expect(exitCode).toBe(1)
  })
})
