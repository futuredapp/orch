// ---------------------------------------------------------------------------
// record.ts — the recorded-agent re-record entrypoint (D9 / parent §5.4, §5.6).
// ---------------------------------------------------------------------------
//
// `bun run tests-new/full-host/recorded-agent/record.ts --scenario <id> --runner claude --prompt '...'`
//   runs the REAL runner once at the Runner boundary with the existing `onEvent`
//   tap installed, partitions the normalised stream into `events` (info) + a
//   single `terminal`, validates + deterministically formats the cassette, and
//   writes `cassettes/<id>.json`.
//
// `--verify --scenario <id>` replays the checked-in cassette through
//   `cassetteToScript` → `FakeRunner.script` (CLI-free) and asserts the round-
//   trip — the event stream a replay produces equals the cassette stream.
//
// Recording touches a real CLI and is human-invoked only (never on the gate).
// The CLI-free pure core (`partitionStream`, `assembleCassette`,
// `verifyCassette`) is what the driver-level test exercises.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  claude,
  codex,
  FakeRunner,
  type InfoEvent,
  isTerminalEvent,
  type Runner,
  type RunnerEvent,
  runRunner,
  type TerminalEvent,
} from '../../../src/runners/index.ts'
import {
  BunClock,
  BunProcessService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import {
  cassetteToScript,
  parseCassette,
  type RecordedAgentCassette,
  serializeCassette,
} from './cassette.ts'

const CASSETTES_DIR = join(import.meta.dir, 'cassettes')

// --- pure core (CLI-free, unit-tested) --------------------------------------

/** Split a captured normalised stream into streamed info events + the single
 *  terminal outcome (the cassette's two fields). Throws on a stream with no
 *  terminal — a recording that never finished is not a valid cassette. */
export function partitionStream(stream: readonly RunnerEvent[]): {
  readonly events: readonly InfoEvent[]
  readonly terminal: TerminalEvent
} {
  const events: InfoEvent[] = []
  let terminal: TerminalEvent | undefined
  for (const evt of stream) {
    if (isTerminalEvent(evt)) {
      terminal = evt
    } else {
      events.push(evt)
    }
  }
  if (terminal === undefined) {
    throw new Error('partitionStream: stream produced no terminal event')
  }
  return { events, terminal }
}

export interface CassetteMeta {
  readonly runner: 'claude' | 'codex'
  readonly runnerVersion?: string
  readonly recordedAt: string
  readonly sourceCommand: readonly string[]
  readonly workflowName: string
  readonly scenarioId: string
  readonly prompt: string
}

/** Build a validated cassette from meta + a captured stream. */
export function assembleCassette(
  meta: CassetteMeta,
  stream: readonly RunnerEvent[],
): RecordedAgentCassette {
  const { events, terminal } = partitionStream(stream)
  const cassette: RecordedAgentCassette = {
    schemaVersion: 1,
    runner: meta.runner,
    ...(meta.runnerVersion !== undefined ? { runnerVersion: meta.runnerVersion } : {}),
    recordedAt: meta.recordedAt,
    sourceCommand: meta.sourceCommand,
    workflowName: meta.workflowName,
    scenarioId: meta.scenarioId,
    prompt: meta.prompt,
    eventSchema: 'RunnerEvent',
    events,
    terminal,
  }
  // Round-trip through the schema so a malformed assembly fails at record time.
  return parseCassette(JSON.parse(serializeCassette(cassette)))
}

export interface VerifyResult {
  readonly ok: boolean
  readonly reason?: string
}

/**
 * Replay a cassette through the fake-agent engine (CLI-free) and assert the
 * produced stream round-trips: the replayed info events equal the cassette's,
 * and the replayed terminal equals the cassette's terminal.
 */
export async function verifyCassette(cassette: RecordedAgentCassette): Promise<VerifyResult> {
  const fps = new FakeProcessService()
  const runner = new FakeRunner(fps).script(cassetteToScript(cassette))
  const captured: RunnerEvent[] = []

  await runRunner(
    runner,
    { cwd: path(process.cwd()), env: {}, prompt: cassette.prompt, extraArgs: [] },
    { processService: fps, clock: new BunClock(), onEvent: (e) => captured.push(e) },
  )

  const replayed = partitionStream(captured)
  if (JSON.stringify(replayed.events) !== JSON.stringify(cassette.events)) {
    return { ok: false, reason: 'replayed info events differ from the cassette' }
  }
  if (JSON.stringify(replayed.terminal) !== JSON.stringify(cassette.terminal)) {
    return { ok: false, reason: 'replayed terminal differs from the cassette' }
  }
  return { ok: true }
}

// --- recording (touches a real CLI; human-invoked) --------------------------

function realRunner(which: 'claude' | 'codex'): Runner {
  return which === 'claude' ? claude() : codex({})
}

async function record(
  scenarioId: string,
  runnerName: 'claude' | 'codex',
  prompt: string,
): Promise<void> {
  const runner = realRunner(runnerName)
  const captured: RunnerEvent[] = []
  const ctx = { cwd: path(process.cwd()), env: {}, prompt, extraArgs: [] as readonly string[] }
  const built = await runner.buildCommand(ctx)

  await runRunner(runner, ctx, {
    processService: new BunProcessService(),
    clock: new BunClock(),
    onEvent: (e) => captured.push(e),
  })

  const cassette = assembleCassette(
    {
      runner: runnerName,
      recordedAt: new Date().toISOString(),
      sourceCommand: built.argv,
      workflowName: scenarioId,
      scenarioId,
      prompt,
    },
    captured,
  )
  const target = join(CASSETTES_DIR, `${scenarioId}.json`)
  writeFileSync(target, serializeCassette(cassette))
  process.stdout.write(`recorded ${captured.length} events → ${target}\n`)
}

function readCassetteFile(scenarioId: string): RecordedAgentCassette {
  const raw = JSON.parse(
    readFileSync(join(CASSETTES_DIR, `${scenarioId}.json`), 'utf-8'),
  ) as unknown
  return parseCassette(raw)
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const scenarioId = arg('--scenario')
  if (scenarioId === undefined) {
    process.stderr.write('record.ts: --scenario <id> is required\n')
    process.exit(2)
  }

  if (process.argv.includes('--verify')) {
    const result = await verifyCassette(readCassetteFile(scenarioId))
    process.stdout.write(
      result.ok ? `verify ok: ${scenarioId}\n` : `verify FAILED: ${result.reason}\n`,
    )
    process.exit(result.ok ? 0 : 1)
  }

  const runnerName = (arg('--runner') ?? 'claude') as 'claude' | 'codex'
  const prompt = arg('--prompt')
  if (prompt === undefined) {
    process.stderr.write('record.ts: --prompt <text> is required to record\n')
    process.exit(2)
  }
  await record(scenarioId, runnerName, prompt)
}
