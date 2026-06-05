// ---------------------------------------------------------------------------
// full-host:fake-agent driver — the full two-pane host on real tmux (parent U2).
// ---------------------------------------------------------------------------
//
// Boots the real two-pane host (`mountTmuxHost`) and drives its agent slot with
// a fake. Two submodes (parent §4):
//   • static (default)   — `FakeRunner.script({ events })`, one per step. Used
//                          whenever a scenario only needs the agent to EMIT.
//   • live-driven        — the `scriptedFake` subprocess puppet, advanced by the
//                          scenario via `app.agent` (type/finish). Selected ONLY
//                          by `meta.liveDriven: true` (D-P2.3) — never inferred.
//
// All real-tmux predictability rules live in `createRealTmuxFixture` /
// `mountTmuxHost.teardown` / `fixture.dispose` (parent §5.4); this driver owns
// calling them and, for the live submode, the leaked-puppet sentinel (parent R1,
// docs/solutions/real-tmux-suite-flakiness-leaked-puppets.md).

import {
  assertNoLeakedEntries,
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type PuppetWorkflowItem,
  type RealTmuxFixture,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'
import type { InfoEvent } from '../../../src/runners/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import { FakeProcessService } from '../../../src/services/index.ts'
import type { AgentSpec } from '../agent-spec.ts'
import type {
  DriverName,
  FullHostApp,
  FullHostSpec,
  LiveAgentControl,
} from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import { RightPane } from '../panes/right-pane.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { createRealTmuxPaneDriver } from './real-tmux-pane-driver.ts'
import type { Driver } from './registry.ts'

const DRIVER_LABEL = 'full-host:fake-agent'

function infoLine(text: string): InfoEvent {
  return { kind: 'info', type: 'assistant', payload: { text } }
}

function emitsTexts(spec: AgentSpec | undefined): readonly string[] {
  return spec?.kind === 'emits' ? spec.texts : []
}

function isLiveSpec(spec: AgentSpec | undefined): boolean {
  return spec?.kind === 'live' || spec?.kind === 'holds-open'
}

function createFullHostFakeAgentApp(
  fixture: RealTmuxFixture,
  harness: MountedHarness,
  fps: FakeProcessService | undefined,
  liveDriven: boolean,
  leakBaseline: number,
): FullHostApp {
  let stepNames: readonly string[] = []
  let runPromise: Promise<unknown> | undefined
  let runSettled = false
  // The live submode holds ONE agent handle for the run: its `.ack` sequence
  // counter is per-handle, so recreating it per call would reset the counter and
  // match a stale ack. Created once in `launch`, reused by every `app.agent` call.
  let liveHandle: ReturnType<MountedHarness['agent']> | undefined
  let readyOnce: Promise<void> | undefined

  const ensureLiveHandle = (): ReturnType<MountedHarness['agent']> => {
    if (liveHandle === undefined) {
      throw new Error(`${DRIVER_LABEL}: app.agent used before launch(spec) started a live run`)
    }
    return liveHandle
  }
  const ensureReady = async (): Promise<void> => {
    if (readyOnce === undefined) readyOnce = ensureLiveHandle().waitForReady()
    await readyOnce
  }

  const paneDeps = (handle: MountedHarness['left']) =>
    createRealTmuxPaneDriver({
      handle,
      stepNames: () => stepNames,
      assertTimeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
      driverLabel: DRIVER_LABEL,
    })

  const leftPane = new LeftPane(paneDeps(harness.left))
  const rightPane = new RightPane(paneDeps(harness.right))

  let liveControl: LiveAgentControl | undefined
  if (liveDriven) {
    liveControl = {
      async type(text: string): Promise<void> {
        await ensureReady()
        await ensureLiveHandle().typeAndSend(text)
      },
      async finish(code?: number): Promise<void> {
        await ensureReady()
        await ensureLiveHandle().finish(code)
      },
    }
  }

  const app: FullHostApp = {
    async launch(spec: FullHostSpec): Promise<void> {
      stepNames = spec.steps
      if (liveDriven !== isLiveSpec(spec.agent)) {
        throw new Error(
          `${DRIVER_LABEL}: meta.liveDriven=${liveDriven} but the launch spec's agent ` +
            'disagrees — a live() / holdsOpen() agent requires liveDriven:true, and ' +
            'emits()/default requires liveDriven:false.',
        )
      }

      if (liveDriven) {
        // Address the handle BEFORE starting the run so an early ack/ready signal
        // is never missed (the canonical puppet-drive order).
        liveHandle = harness.agent(requireFirstStep(spec.steps))
        const items: PuppetWorkflowItem[] = spec.steps.map((name) => ({ name }))
        runPromise = harness.runPuppetWorkflow(items)
      } else {
        const texts = emitsTexts(spec.agent)
        if (fps === undefined) throw new Error(`${DRIVER_LABEL}: static build missing FakeProcessService`)
        const steps = spec.steps.map((name) => ({
          name,
          agent: new FakeRunner(fps).script({
            events: texts.map(infoLine),
            structuredOutput: 'done',
          }),
        }))
        runPromise = harness.runWorkflow(steps)
      }
      // Never leave the run promise unobserved — that would surface as an
      // unhandled rejection if the workflow errors before `complete`/`teardown`.
      runPromise.catch(() => {}).finally(() => {
        runSettled = true
      })
    },

    async complete(_step: string): Promise<void> {
      // Static: the whole FakeRunner workflow already runs to completion; await
      // it. Live: finish the puppet step so the run can settle, then await it.
      if (liveDriven) {
        await ensureReady()
        await ensureLiveHandle().finish()
      }
      await runPromise?.catch(() => {})
    },

    leftPane,
    rightPane,
    ...(liveControl !== undefined ? { agent: liveControl } : {}),

    async teardown(): Promise<void> {
      // A still-open live puppet step would hang `host.teardown()` (it waits on
      // the in-process workflow, which is parked awaiting the puppet's finish).
      // So finish the open puppet first (best-effort) to let the run settle,
      // THEN tear the host down. Static runs already settled via `complete`.
      if (liveDriven && !runSettled && liveHandle !== undefined) {
        await liveControl?.finish().catch(() => {})
        await runPromise?.catch(() => {})
      }
      await harness.teardown()
      await runPromise?.catch(() => {})
      await fixture.dispose()
      // Live submode only: turn a leaked puppet into a loud failure (parent R1).
      if (liveDriven) await assertNoLeakedEntries(leakBaseline)
    },
  }
  return app
}

function requireFirstStep(stepNames: readonly string[]): string {
  const first = stepNames[0]
  if (first === undefined) {
    throw new Error(`${DRIVER_LABEL}: app.agent used before launch(spec) set any steps`)
  }
  return first
}

async function build(meta: ScenarioMeta<readonly DriverName[]>): Promise<FullHostApp> {
  const liveDriven = meta.liveDriven === true
  const leakBaseline = await scriptedFakeEntryCount()
  const fixture = await createRealTmuxFixture({ env: {} })

  // Static FakeRunner stubs its argv on a FakeProcessService; the live puppet
  // needs the fixture's real BunProcessService (it spawns a subprocess).
  const fps = liveDriven ? undefined : new FakeProcessService()
  const harness = await mountTmuxHost(
    fixture,
    fps !== undefined ? { agentProcessService: fps } : {},
  )

  return createFullHostFakeAgentApp(fixture, harness, fps, liveDriven, leakBaseline)
}

export const fullHostFakeAgentDriver: Driver<FullHostApp> = {
  build,
  skip: () => !canRunRealTmux(),
  timeout: REAL_TMUX_TEST_TIMEOUT_MS,
}
