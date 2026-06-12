/**
 * Integration (U4): drive `interactive-entry.ts` as a real subprocess.
 *
 * The interactive entry is spawned by the two-pane host as a real PTY, but its
 * engine wiring — both input channels routed through the shared command engine,
 * the `.ready` marker, per-sequence acks, and the cross-channel ordering
 * contract — is verified here without tmux by spawning the entry with piped
 * stdin (`rawStreams: true`) and a temp run state dir. The real-PTY render and
 * manual typing through tmux `send-keys` are covered at the U7 layer.
 *
 * No mocks — `bun`, `BunProcessService`, and the filesystem are real edges.
 * Every assertion is gated on a durable on-disk signal (render log, `.ack`,
 * `.ready`), never a pane scrape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  type ControlPaths,
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
  resolveControlPaths,
  scriptedFake,
} from '../../../src/runners/scripted-fake/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import { path as toPath } from '../../../src/services/types.ts'

const REPO_ROOT = nodePath.resolve(import.meta.dir, '../../..')
const POLL_MS = 20
const TIMEOUT_MS = 5_000

interface DrivenEntry {
  readonly paths: ControlPaths
  writeStdin(data: string): void
  append(cmd: Readonly<Record<string, unknown>>): Promise<number>
  waitForReady(): Promise<void>
  waitForRender(needle: string): Promise<string>
  waitForAck(seq: number): Promise<void>
  wait(): Promise<{ readonly exitCode: number }>
  kill(): void
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function pollUntil(pred: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

// Spawn the interactive entry with piped stdin and a derived control transport.
function spawnInteractive(runStateDir: string, key: string): DrivenEntry {
  const ps = new BunProcessService()
  const runner = scriptedFake({ stepName: key, interactive: true })
  const cmd = runner.buildCommand({
    cwd: toPath(runStateDir),
    env: {
      [ORCH_STEP_KEY_ENV]: key,
      [ORCH_RUN_STATE_DIR_ENV]: runStateDir,
      // Our own pid as the orch parent — keeps the self-reap dormant while the
      // test drives the entry.
      [ORCH_PARENT_PID_ENV]: String(process.pid),
    },
    prompt: 'noop',
    extraArgs: [],
  })
  const handle = ps.spawn({
    argv: cmd.argv,
    env: cmd.env,
    cwd: toPath(REPO_ROOT),
    rawStreams: true,
  })

  // Drain both streams so the child never blocks on pipe backpressure.
  void (async () => {
    for await (const _ of handle.stdout) {
      /* discard — the durable oracle is the render log, not stdout */
    }
  })()
  void (async () => {
    for await (const _ of handle.stderr) {
      /* drain */
    }
  })()

  const paths = resolveControlPaths({ runStateDir, key })
  let seq = 0

  return {
    paths,
    writeStdin: (data: string) => handle.writeStdin?.(data),
    append: async (command) => {
      await mkdir(paths.controlDir, { recursive: true })
      seq += 1
      await appendFile(paths.controlPath, `${JSON.stringify(command)}\n`, 'utf-8')
      return seq
    },
    waitForReady: () => pollUntil(() => fileExists(paths.readyPath), 'ready marker'),
    waitForRender: async (needle: string) => {
      let body = ''
      await pollUntil(
        async () => {
          body = await readFile(paths.renderLogPath, 'utf-8').catch(() => '')
          return body.includes(needle)
        },
        `render of ${JSON.stringify(needle)}`,
      )
      return body
    },
    waitForAck: (n: number) =>
      pollUntil(() => fileExists(nodePath.join(paths.ackDir, `${n}.ack`)), `ack #${n}`),
    wait: () => handle.wait(),
    kill: () => handle.kill('SIGKILL'),
  }
}

let runStateDir: string
let entries: DrivenEntry[] = []

beforeEach(async () => {
  runStateDir = await mkdtemp(nodePath.join(tmpdir(), 'scripted-fake-interactive-'))
})

afterEach(async () => {
  for (const e of entries) e.kill()
  entries = []
  await rm(runStateDir, { recursive: true, force: true })
})

function track(entry: DrivenEntry): DrivenEntry {
  entries.push(entry)
  return entry
}

describe('scriptedFake({ interactive }) construction', () => {
  it('reports supports.interactive true only when constructed interactive', () => {
    const headless = scriptedFake({ stepName: 's' })
    const interactive = scriptedFake({ stepName: 's', interactive: true })

    expect(headless.supports.interactive).toBe(false)
    expect(interactive.supports.interactive).toBe(true)
  })

  it('selects the interactive entry argv when interactive', () => {
    const ctx = { cwd: toPath('/tmp'), env: {}, prompt: '', extraArgs: [] }
    const headlessArgv = scriptedFake({ stepName: 's' }).buildCommand(ctx)
    const interactiveArgv = scriptedFake({ stepName: 's', interactive: true }).buildCommand(ctx)

    expect((headlessArgv as { argv: readonly string[] }).argv.join(' ')).toContain('__entry.ts')
    expect((interactiveArgv as { argv: readonly string[] }).argv.join(' ')).toContain(
      'interactive-entry.ts',
    )
  })
})

describe('interactive-entry.ts control channel (real subprocess)', () => {
  it('writes the .ready marker once idle-waiting after render setup', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))

    await entry.waitForReady()

    expect(await fileExists(entry.paths.readyPath)).toBe(true)
  })

  it('renders a control type_and_send line to the durable render log and acks it', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    const seq = await entry.append({ cmd: 'type_and_send', text: 'hello' })
    await entry.waitForAck(seq)
    const body = await entry.waitForRender('hello')

    expect(body).toBe('hello\n')
  })

  it('terminates on a control finish and exits 0', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    const seq = await entry.append({ cmd: 'finish' })
    await entry.waitForAck(seq)
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(0)
  })

  it('propagates a non-zero finish code so the host can mark the step failed', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    // The entry now exits with the resolved code: tmux `remain-on-exit` keeps the
    // dead pane's `#{pane_dead_status}` readable, so the two-pane host recovers a
    // non-zero exit instead of always treating it as clean.
    const seq = await entry.append({ cmd: 'finish', code: 2 })
    await entry.waitForAck(seq)
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(2)
  })

  it('exits non-zero on a control fail command (simulated failure)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    const seq = await entry.append({ cmd: 'fail', message: 'simulated failure' })
    await entry.waitForAck(seq)
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(1)
  })

  it('renders the failure message to the render log on a control fail', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    await entry.append({ cmd: 'fail', message: 'kaboom' })
    const body = await entry.waitForRender('kaboom')

    expect(body).toBe('kaboom\n')
  })
})

describe('interactive-entry.ts manual stdin channel (real subprocess)', () => {
  it('renders a bare manual line identically to a control type_and_send (R3, R5)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    entry.writeStdin('typed-by-hand\n')
    const body = await entry.waitForRender('typed-by-hand')

    expect(body).toBe('typed-by-hand\n')
  })

  it('ends the step on manual q (R5)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    entry.writeStdin('q\n')
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(0)
  })

  it('ends the step on manual exit (R5)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    entry.writeStdin('exit\n')
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(0)
  })

  it('exits non-zero on the manual fail keyword (simulated failure)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    entry.writeStdin('fail\n')
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(1)
  })

  it('ignores an empty manual line, rendering nothing (R3 empty-line parity)', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    entry.writeStdin('\n')
    entry.writeStdin('after\n')
    const body = await entry.waitForRender('after')

    expect(body).toBe('after\n')
  })
})

describe('interactive-entry.ts cross-channel ordering (R12 — no silent ack hang)', () => {
  it('acks a control command even when a stdin finish arrives concurrently', async () => {
    const entry = track(spawnInteractive(runStateDir, 'step'))
    await entry.waitForReady()

    // Append a control command and, without awaiting its ack, fire a manual
    // finish. The single engine queue must process the already-appended command
    // (and write its ack) before the finish terminates the process — otherwise
    // a driver awaiting the ack would hang forever.
    const seq = await entry.append({ cmd: 'type_and_send', text: 'race' })
    entry.writeStdin('q\n')

    await entry.waitForAck(seq)
    const { exitCode } = await entry.wait()

    expect(exitCode).toBe(0)
  })
})
