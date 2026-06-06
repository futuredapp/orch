import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canRunRealTmux,
  REAL_TMUX_TEST_TIMEOUT_MS,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'
import {
  cassetteToScript,
  parseCassette,
  type RecordedAgentCassette,
  serializeCassette,
} from '../../../full-host/recorded-agent/cassette.ts'
import { verifyCassette } from '../../../full-host/recorded-agent/record.ts'
import type { DriverName, FullHostApp } from '../../app-surfaces.ts'
import type { ScenarioMeta } from '../../scenario.ts'
import { fullHostRecordedAgentDriver } from '../full-host-recorded-agent-driver.ts'

// Driver-level tests for `full-host:recorded-agent`. The cassette schema +
// replay round-trip are CLI-free and run anywhere; the build/teardown lifecycle
// check requires real tmux (but never a real CLI — the cassette replays through
// FakeRunner). Validates D9 / D-P3.1 / D-P3.2.

const tmuxAvailable = canRunRealTmux()

const FIXTURE_PATH = join(
  import.meta.dir,
  '../../../full-host/recorded-agent/cassettes/claude-plan-then-work.json',
)

function readFixture(): RecordedAgentCassette {
  return parseCassette(JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')))
}

const META: ScenarioMeta<readonly DriverName[]> = {
  name: 'recorded-driver-test',
  drivers: ['full-host:recorded-agent'],
  feature: 'driver',
  oldTestRefs: [],
}

let apps: FullHostApp[] = []

afterEach(async () => {
  for (const app of apps) await app.teardown().catch(() => {})
  apps = []
})

describe('recorded-agent cassette — schema validation (D9)', () => {
  it('accepts a well-formed cassette and exposes its split events + terminal', () => {
    const cassette = readFixture()

    expect(cassette.schemaVersion).toBe(1)
    expect(cassette.eventSchema).toBe('RunnerEvent')
    expect(cassette.events.every((e) => e.kind === 'info')).toBe(true)
    expect(cassette.terminal.kind).toBe('terminal')
  })

  it('rejects a cassette missing the terminal outcome', () => {
    const { terminal: _omit, ...withoutTerminal } = readFixture()

    expect(() => parseCassette(withoutTerminal)).toThrow(/invalid cassette/)
  })

  it('rejects a cassette whose eventSchema is not RunnerEvent', () => {
    const bad = { ...readFixture(), eventSchema: 'raw-stdout' }

    expect(() => parseCassette(bad)).toThrow(/invalid cassette/)
  })
})

describe('recorded-agent cassette — replay shim (D-P3.1)', () => {
  it('maps a turn-complete terminal to structuredOutput', () => {
    const script = cassetteToScript(readFixture())

    expect(script.structuredOutput).toBe('done')
    expect(script.failWith).toBeUndefined()
  })

  it('maps an error terminal to failWith', () => {
    const cassette: RecordedAgentCassette = {
      ...readFixture(),
      terminal: { kind: 'terminal', type: 'error', message: 'boom' },
    }

    const script = cassetteToScript(cassette)

    expect(script.failWith).toEqual({ message: 'boom' })
    expect(script.structuredOutput).toBeUndefined()
  })

  it('round-trips the cassette stream through FakeRunner replay', async () => {
    const result = await verifyCassette(readFixture())

    expect(result.ok).toBe(true)
  })
})

describe('recorded-agent cassette — deterministic serializer (D-P3.5)', () => {
  it('serializes the same cassette to byte-identical output twice', () => {
    const cassette = readFixture()

    expect(serializeCassette(cassette)).toBe(serializeCassette(cassette))
  })

  it('emits a trailing newline and sorted top-level keys', () => {
    const out = serializeCassette(readFixture())

    expect(out.endsWith('}\n')).toBe(true)
    const keys = Object.keys(JSON.parse(out))
    expect(keys).toEqual([...keys].sort())
  })
})

describe('recorded-agent driver — real-tmux lifecycle, no real CLI', () => {
  it('budgets the test with REAL_TMUX_TEST_TIMEOUT_MS and skips on a box without tmux', () => {
    expect(fullHostRecordedAgentDriver.timeout).toBe(REAL_TMUX_TEST_TIMEOUT_MS)
    expect(fullHostRecordedAgentDriver.skip()).toBe(!canRunRealTmux())
  })

  it.skipIf(!tmuxAvailable)(
    'replays the fixture cassette into the right pane and reaps cleanly with no leaks',
    async () => {
      const socketsBefore = listOrchSockets()
      const leakBefore = await scriptedFakeEntryCount()

      const app = await fullHostRecordedAgentDriver.build(META)
      apps.push(app)
      await app.launch({
        steps: ['plan'],
        agent: { kind: 'cassette', file: 'claude-plan-then-work.json' },
      })
      await app.complete('plan')

      // The recorded assistant text painted in the right pane — replay reached
      // the real two-pane host. No real CLI ran (FakeRunner replays the cassette).
      await app.rightPane.assertShowsContent('plan recorded')
      expect(listOrchSockets().length).toBeGreaterThan(socketsBefore.length)

      await app.teardown()

      expect(listOrchSockets()).toEqual(socketsBefore)
      expect(await scriptedFakeEntryCount()).toBe(leakBefore)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

function listOrchSockets(): string[] {
  const dir = `${process.env.TMUX_TMPDIR ?? '/tmp'}/tmux-${process.getuid?.() ?? 0}`
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.startsWith('orch-'))
      .sort()
  } catch {
    return []
  }
}
