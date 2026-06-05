// ---------------------------------------------------------------------------
// full-host:fake-agent driver — the full two-pane host on real tmux (parent U2).
// ---------------------------------------------------------------------------
//
// Boots the real two-pane host (`mountTmuxHost`) and drives its agent slot with
// a fake. Two submodes (parent §4):
//   • static (default)   — `FakeRunner.script({ events })`, one per step. Served
//                          by the SHARED `createStaticFullHostApp` factory, which
//                          the recorded/real drivers reuse (no copy-paste, P3-C).
//   • live-driven        — the `scriptedFake` subprocess puppet, advanced by the
//                          scenario via `app.agent` (type/finish). Selected ONLY
//                          by `meta.liveDriven: true` (D-P2.3) — never inferred.
//                          Intrinsically fake-agent-only, so it stays here.
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
import { createStaticFullHostApp } from './full-host-static-app.ts'
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

// ---------------------------------------------------------------------------
// Live-driven submode (scriptedFake subprocess puppet) — fake-agent-only.
// ---------------------------------------------------------------------------

function createLiveFullHostApp(
  fixture: RealTmuxFixture,
  harness: MountedHarness,
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
      // Navigation always drives the steps (left) pane; `sendKeys` targets it.
      sendKey: (input) => harness.sendKeys(input),
    })

  const leftPane = new LeftPane(paneDeps(harness.left))
  const rightPane = new RightPane(paneDeps(harness.right))

  const liveControl: LiveAgentControl = {
    async type(text: string): Promise<void> {
      await ensureReady()
      await ensureLiveHandle().typeAndSend(text)
    },
    async finish(code?: number): Promise<void> {
      await ensureReady()
      await ensureLiveHandle().finish(code)
    },
  }

  const app: FullHostApp = {
    async launch(spec: FullHostSpec): Promise<void> {
      stepNames = spec.steps
      if (!isLiveSpec(spec.agent)) {
        throw new Error(
          `${DRIVER_LABEL}: meta.liveDriven=true but the launch spec's agent is not ` +
            'live() / holdsOpen() — a live build requires a live agent spec.',
        )
      }
      // Address the handle BEFORE starting the run so an early ack/ready signal
      // is never missed (the canonical puppet-drive order).
      liveHandle = harness.agent(requireFirstStep(spec.steps))
      const items: PuppetWorkflowItem[] = spec.steps.map((name) => ({ name }))
      runPromise = harness.runPuppetWorkflow(items)
      runPromise
        .catch(() => {})
        .finally(() => {
          runSettled = true
        })
    },

    async complete(_step: string): Promise<void> {
      // Finish the puppet step so the run can settle, then await it.
      await ensureReady()
      await ensureLiveHandle().finish()
      await runPromise?.catch(() => {})
    },

    leftPane,
    rightPane,
    agent: liveControl,

    async teardown(): Promise<void> {
      // A still-open live puppet step would hang `host.teardown()` (it waits on
      // the in-process workflow, which is parked awaiting the puppet's finish).
      // So finish the open puppet first (best-effort) to let the run settle,
      // THEN tear the host down.
      if (!runSettled && liveHandle !== undefined) {
        await liveControl.finish().catch(() => {})
        await runPromise?.catch(() => {})
      }
      await harness.teardown()
      await runPromise?.catch(() => {})
      await fixture.dispose()
      // Turn a leaked puppet into a loud failure (parent R1).
      await assertNoLeakedEntries(leakBaseline)
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

  if (liveDriven) {
    // The live puppet needs the fixture's real BunProcessService (it spawns a
    // subprocess), so no agentProcessService override is passed.
    const harness = await mountTmuxHost(fixture, {})
    return createLiveFullHostApp(fixture, harness, leakBaseline)
  }

  // Static FakeRunner stubs its argv on a FakeProcessService.
  const fps = new FakeProcessService()
  const harness = await mountTmuxHost(fixture, { agentProcessService: fps })

  return createStaticFullHostApp({
    fixture,
    harness,
    label: DRIVER_LABEL,
    agentForStep: (_name, _index, spec) => {
      if (isLiveSpec(spec.agent)) {
        throw new Error(
          `${DRIVER_LABEL}: a live() / holdsOpen() agent requires meta.liveDriven:true; ` +
            'the static build cannot drive it.',
        )
      }
      return {
        agent: new FakeRunner(fps).script({
          events: emitsTexts(spec.agent).map(infoLine),
          structuredOutput: 'done',
        }),
      }
    },
  })
}

export const fullHostFakeAgentDriver: Driver<FullHostApp> = {
  build,
  skip: () => !canRunRealTmux(),
  timeout: REAL_TMUX_TEST_TIMEOUT_MS,
}
