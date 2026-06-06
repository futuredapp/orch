// U3 — headless puppet addressing: the entry resolves its control transport at
// run time from the threaded step key under the run state dir, emits a `.ready`
// marker once idle, keeps the per-sequence `.ack`, and lets a baked
// `controlPath` win for behavioral-dsl backward compat.
//
// These tests spawn `__entry.ts` directly (the only way to exercise the
// *derived* path — the Tier 5 behavioral-dsl harness always bakes a
// controlPath, so its end-to-end coverage of the baked path lives in
// tests/integration/lifecycle/*.behavioral.real.test.ts). Each test drives the
// on-disk contract: append a command, await its ack, await the ready marker.

import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { encodeKey, resolveControlPaths } from '../../../src/runners/scripted-fake/index.ts'

const ENTRY = new URL('../../../src/runners/scripted-fake/__entry.ts', import.meta.url).pathname

interface SpawnOpts {
  readonly runStateDir: string
  readonly stepKey: string
  /** Script row name (ORCH_LIFECYCLE_STEP_NAME). Defaults to stepKey. */
  readonly scriptName?: string
  /** When set, bakes controlPath into the puppet script (baked-wins path). */
  readonly bakedControlPath?: string
}

const children: Array<{ kill(): void }> = []

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
})

async function spawnEntry(opts: SpawnOpts): Promise<{ proc: ReturnType<typeof Bun.spawn> }> {
  const scriptName = opts.scriptName ?? opts.stepKey
  const scriptPath = nodePath.join(opts.runStateDir, 'script.json')
  const puppet =
    opts.bakedControlPath !== undefined
      ? { kind: 'puppet', controlPath: opts.bakedControlPath }
      : { kind: 'puppet' }
  await writeFile(scriptPath, JSON.stringify({ steps: { [scriptName]: puppet } }), 'utf-8')

  const proc = Bun.spawn({
    cmd: ['bun', ENTRY],
    env: {
      ...process.env,
      ORCH_LIFECYCLE_SCRIPT: scriptPath,
      ORCH_LIFECYCLE_STEP_NAME: scriptName,
      ORCH_STEP_KEY: opts.stepKey,
      ORCH_RUN_STATE_DIR: opts.runStateDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(proc)
  return { proc }
}

const POLL_MS = 20
const TIMEOUT_MS = 10_000

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    try {
      await stat(path)
      return
    } catch {
      /* not yet */
    }
    if (Date.now() >= deadline) throw new Error(`waitForFile: ${path} did not appear`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function fileMissing(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch {
    return true
  }
}

let seqCounter = 0
async function append(controlPath: string, cmd: unknown): Promise<number> {
  seqCounter += 1
  await appendFile(controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
  return seqCounter
}

async function freshTmp(): Promise<string> {
  return mkdtemp(nodePath.join(tmpdir(), 'orch-u3-'))
}

describe('U3 — derived control path under the run state dir (R7)', () => {
  it('resolves <runStateDir>/test-control/<key>.ndjson for a simple key', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'step2' })

    await spawnEntry({ runStateDir, stepKey: 'step2' })
    await waitForFile(paths.controlPath)

    expect(paths.controlPath).toBe(nodePath.join(runStateDir, 'test-control', 'step2.ndjson'))
    await rm(runStateDir, { recursive: true, force: true })
  })

  it('sanitizes a key with > / : separators into one injective filename (R10)', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const key = 'inner>plan:vars-abc'
    const paths = resolveControlPaths({ runStateDir, key })

    await spawnEntry({ runStateDir, stepKey: key, scriptName: key })
    await waitForFile(paths.controlPath)

    expect(nodePath.basename(paths.controlPath)).toBe(`${encodeKey(key)}.ndjson`)
    expect(paths.controlPath).not.toContain('>')
    expect(paths.controlPath).not.toContain(':')
    await rm(runStateDir, { recursive: true, force: true })
  })

  it('maps distinct keys a>b and a:b to distinct transport files (injectivity, R10)', () => {
    const runStateDir = '/tmp/whatever'

    const ab = resolveControlPaths({ runStateDir, key: 'a>b' })
    const ac = resolveControlPaths({ runStateDir, key: 'a:b' })

    expect(ab.controlPath).not.toBe(ac.controlPath)
  })

  it('isolates two runs with the same key under distinct runId dirs (R11)', () => {
    const a = resolveControlPaths({ runStateDir: '/base/run-A', key: 's' })
    const b = resolveControlPaths({ runStateDir: '/base/run-B', key: 's' })

    expect(a.controlPath).not.toBe(b.controlPath)
  })
})

describe('U3 — ack confirmation (R12, AE6)', () => {
  it('writes a matching <seq>.ack for each appended command', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'acker' })

    const { proc } = await spawnEntry({ runStateDir, stepKey: 'acker' })
    await waitForFile(paths.controlPath)

    const seq1 = await append(paths.controlPath, { cmd: 'type_and_send', text: 'hello' })
    await waitForFile(nodePath.join(paths.ackDir, `${seq1}.ack`))

    const seq2 = await append(paths.controlPath, { cmd: 'finish' })
    await waitForFile(nodePath.join(paths.ackDir, `${seq2}.ack`))

    expect(await proc.exited).toBe(0)
    await rm(runStateDir, { recursive: true, force: true })
  })

  it('propagates a non-zero finish code: terminal error on stdout + matching exit code (R2)', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'failer' })

    const { proc } = await spawnEntry({ runStateDir, stepKey: 'failer' })
    await waitForFile(paths.controlPath)

    await append(paths.controlPath, { cmd: 'finish', code: 2 })

    const exitCode = await proc.exited
    // `stdout: 'pipe'` yields a ReadableStream, but the bare `ReturnType<typeof
    // Bun.spawn>` widens the field to `number | ReadableStream | undefined`.
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
    expect(exitCode).toBe(2)
    // Headless finish(non-zero) emits a terminal/error the executor maps to
    // step:failed — not a turn-complete.
    expect(stdout).toContain('"type":"error"')
    expect(stdout).not.toContain('turn-complete')
    await rm(runStateDir, { recursive: true, force: true })
  })
})

describe('U3 — readiness marker (R13, AE5)', () => {
  it('writes the .ready marker once the instance is idle-waiting', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'ready1' })

    await spawnEntry({ runStateDir, stepKey: 'ready1' })
    await waitForFile(paths.readyPath)

    const body = await readFile(paths.readyPath, 'utf-8')
    expect(body.length).toBeGreaterThan(0) // carries the attempt's pid
    await rm(runStateDir, { recursive: true, force: true })
  })

  it('deletes a stale marker at spawn and re-writes it from the new attempt', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'ready2' })
    // Simulate a retry/resume leaving a stale marker in the same runId dir.
    await mkdir(paths.controlDir, { recursive: true })
    await writeFile(paths.readyPath, 'STALE-FROM-PRIOR-ATTEMPT', 'utf-8')

    const { proc } = await spawnEntry({ runStateDir, stepKey: 'ready2' })
    // The new attempt deletes the stale marker, then re-writes its own pid.
    const childPid = String(proc.pid)
    const deadline = Date.now() + TIMEOUT_MS
    let body = 'STALE-FROM-PRIOR-ATTEMPT'
    while (body !== childPid && Date.now() < deadline) {
      body = await readFile(paths.readyPath, 'utf-8').catch(() => 'STALE-FROM-PRIOR-ATTEMPT')
      if (body !== childPid) await new Promise((r) => setTimeout(r, POLL_MS))
    }

    expect(body).toBe(childPid)
    await rm(runStateDir, { recursive: true, force: true })
  })
})

describe('U3 — cursor-from-0 tail', () => {
  it('processes a command appended to the control file before the agent starts', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const paths = resolveControlPaths({ runStateDir, key: 'early' })
    // Pre-create the control file WITH a command before spawning.
    await mkdir(paths.controlDir, { recursive: true })
    await mkdir(paths.ackDir, { recursive: true })
    await writeFile(paths.controlPath, `${JSON.stringify({ cmd: 'finish' })}\n`, 'utf-8')

    const { proc } = await spawnEntry({ runStateDir, stepKey: 'early' })

    // The pre-existing finish (seq 1) is read from cursor 0 and acked.
    await waitForFile(nodePath.join(paths.ackDir, '1.ack'))
    expect(await proc.exited).toBe(0)
    await rm(runStateDir, { recursive: true, force: true })
  })
})

describe('U3 — baked controlPath wins (backward compat)', () => {
  it('uses the baked path and ignores the threaded key when both are present', async () => {
    const runStateDir = await freshTmp()
    seqCounter = 0
    const bakedControlPath = nodePath.join(runStateDir, 'legacy', 'plan.ndjson')
    await mkdir(nodePath.dirname(bakedControlPath), { recursive: true })
    // A different threaded key — its derived path must NOT be the one used.
    const derived = resolveControlPaths({ runStateDir, key: 'different-key' })

    const { proc } = await spawnEntry({
      runStateDir,
      stepKey: 'different-key',
      scriptName: 'plan',
      bakedControlPath,
    })
    await waitForFile(bakedControlPath)

    // Drive end-to-end against the BAKED path: append + await ack.
    const seq = await append(bakedControlPath, { cmd: 'finish' })
    await waitForFile(`${bakedControlPath}.acks/${seq}.ack`)

    expect(await fileMissing(derived.controlPath)).toBe(true)
    expect(await proc.exited).toBe(0)
    await rm(runStateDir, { recursive: true, force: true })
  })
})
