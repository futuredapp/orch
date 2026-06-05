// ---------------------------------------------------------------------------
// full-host:recorded-agent driver — replay a normalised-event cassette (U3).
// ---------------------------------------------------------------------------
//
// Reuses the SHARED static full-host engine (`createStaticFullHostApp`) — the
// ONLY difference from `full-host:fake-agent` static is the event SOURCE: a
// `CassetteSpec` loads a checked-in cassette and produces the same
// `FakeRunner.script(...)` call the inline `emits()` path produces (D-P3.2,
// parent §5.6 "Replay = fake-agent engine, different event source"). It boots
// real tmux but spawns NO real CLI — deterministic, CLI-free, safe on the gate.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
} from '@orch/test/real-tmux/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'
import { cassetteToScript, parseCassette } from '../../full-host/recorded-agent/cassette.ts'
import type { DriverName, FullHostApp, FullHostSpec } from '../app-surfaces.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { createStaticFullHostApp } from './full-host-static-app.ts'
import type { Driver } from './registry.ts'

const DRIVER_LABEL = 'full-host:recorded-agent'

const CASSETTES_DIR = join(import.meta.dir, '../../full-host/recorded-agent/cassettes')

function loadCassetteScript(fps: FakeProcessService, file: string) {
  const raw = JSON.parse(readFileSync(join(CASSETTES_DIR, file), 'utf-8')) as unknown
  const cassette = parseCassette(raw)
  return new FakeRunner(fps).script(cassetteToScript(cassette))
}

async function build(_meta: ScenarioMeta<readonly DriverName[]>): Promise<FullHostApp> {
  const fixture = await createRealTmuxFixture({ env: {} })
  // The cassette replays through FakeRunner, which stubs its argv on a
  // FakeProcessService — no real CLI ever spawns.
  const fps = new FakeProcessService()
  const harness = await mountTmuxHost(fixture, { agentProcessService: fps })

  return createStaticFullHostApp({
    fixture,
    harness,
    label: DRIVER_LABEL,
    agentForStep: (_name, _index, spec: FullHostSpec) => {
      if (spec.agent?.kind !== 'cassette') {
        throw new Error(
          `${DRIVER_LABEL}: launch spec's agent must be fromCassette(...); got ` +
            `${spec.agent?.kind ?? 'undefined'}.`,
        )
      }
      return { agent: loadCassetteScript(fps, spec.agent.file) }
    },
  })
}

export const fullHostRecordedAgentDriver: Driver<FullHostApp> = {
  build,
  skip: () => !canRunRealTmux(),
  timeout: REAL_TMUX_TEST_TIMEOUT_MS,
}
