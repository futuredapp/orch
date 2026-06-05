// ---------------------------------------------------------------------------
// lifecycle driver — outside-in process behaviour over a real orch subprocess.
// ---------------------------------------------------------------------------
//
// Wraps the behavioral-dsl engine (a real `orch` subprocess under real tmux,
// driven via control files) behind the typed `LifecycleApp` surface (parent
// §3.5). It is intrinsically subprocess + real-tmux + control-file bound, so it
// is NOT flattened into the model substrate. All predictability rules live in
// the behavioral-dsl engine's `launchOrchWorkflow` / `OrchHandle.teardown`
// (unique reserved socket, detached-server reaping, poll-and-resend); this
// driver owns calling them and the leaked-puppet sentinel (parent R1).
//
// Concurrency: the behavioral-dsl helpers key off a process-global "current
// handle", so lifecycle scenarios MUST run serially (`--max-concurrency=1`,
// D6/D14) — there is no per-call handle threading.

import { readFile } from 'node:fs/promises'
import {
  assertOrchExits,
  assertTmuxSession,
  exitedNormally as exitedNormallyMatcher,
  holdUntilReleased,
  launchOrchWorkflow,
  type OrchHandle,
  pressKeyInPane,
  signalOrch,
  snapToLive,
  tmuxIsTornDown as tmuxIsTornDownMatcher,
  userAction,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import {
  assertNoLeakedEntries,
  canRunRealTmux,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'
import type { AgentSpec } from '../agent-spec.ts'
import type {
  DriverName,
  LifecycleApp,
  LifecycleSpec,
  Signal,
} from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import type { PaneDriver } from '../panes/pane-driver.ts'
import { RightPane } from '../panes/right-pane.ts'
import {
  type PersistedStatus,
  SystemAssertions,
  type SystemAssertionsBackend,
} from '../panes/system-assertions.ts'
import { notImplemented } from '../not-implemented.ts'
import type { ScenarioMeta } from '../scenario.ts'
import type { Driver } from './registry.ts'

const DRIVER_LABEL = 'lifecycle'
const PERSISTED_STATUS_POLL_MS = 50
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'crashed'])

// Map a step-name sequence to the on-disk fixture that defines exactly those
// steps. The behavioral-dsl fixtures are fixed, so a lifecycle scenario picks
// one by listing its steps (parent §5.2 LifecycleSpec). Fixtures themselves
// relocate from tests/fixtures/lifecycle in a later parent phase.
const FIXTURE_BY_STEPS: Readonly<Record<string, string>> = {
  work: 'single-agent-step',
  'plan,execute': 'two-step-linear',
  'plan,execute,finalize': 'three-step-linear',
}

type StepScript = Readonly<Record<string, unknown>>

function resolveFixtureName(steps: readonly string[]): string {
  const key = steps.join(',')
  const fixture = FIXTURE_BY_STEPS[key]
  if (fixture === undefined) {
    throw new Error(
      `${DRIVER_LABEL}: no behavioral-dsl fixture defines steps [${key}]. ` +
        `Available: ${Object.keys(FIXTURE_BY_STEPS).join(' | ')}.`,
    )
  }
  return fixture
}

function isHeld(spec: LifecycleSpec, agent: AgentSpec | undefined): boolean {
  return agent?.kind === 'holds-open' || spec.stopAt === 'mid-step'
}

interface LaunchPlan {
  readonly script: StepScript
  readonly bringToState: { readonly kind: 'mid-step'; readonly name: string } | { readonly kind: 'completed' }
}

function planLaunch(spec: LifecycleSpec): LaunchPlan {
  const last = spec.steps[spec.steps.length - 1]
  if (last === undefined) throw new Error(`${DRIVER_LABEL}: launch spec has no steps`)

  if (isHeld(spec, spec.agent)) {
    // Hold the LAST step (matching `stopAt: 'mid-step'` = all-but-last done,
    // last running); the rest complete instantly so we land on the live edge.
    const script: Record<string, unknown> = {}
    for (const name of spec.steps) {
      script[name] = name === last ? holdUntilReleased() : { kind: 'instant-ok' }
    }
    return { script, bringToState: { kind: 'mid-step', name: last } }
  }

  const script: Record<string, unknown> = {}
  for (const name of spec.steps) script[name] = { kind: 'instant-ok' }
  return { script, bringToState: { kind: 'completed' } }
}

// The lifecycle driver does not read panes in parent U2 (its tracer + regression
// tests exercise press/signal/system only). Pane reads over the subprocess
// snapshot land with the first migration unit that needs them (parent U4+).
function deferredPaneDriver(): PaneDriver {
  const defer = (method: string): Promise<never> =>
    notImplemented(`${DRIVER_LABEL}: LeftPane/RightPane.${method} (subprocess-snapshot pane reads)`)
  return {
    assertBottomText: () => defer('assertBottomText'),
    assertContains: () => defer('assertContains'),
    assertSelected: () => defer('assertSelected'),
    assertGlyph: () => defer('assertGlyph'),
    selectStep: () => defer('selectStep'),
    followLive: () => defer('followLive'),
    browseTo: () => defer('browseTo'),
    assertPreviewCursorOn: () => defer('assertPreviewCursorOn'),
    assertStepVisible: () => defer('assertStepVisible'),
    assertStepOffscreen: () => defer('assertStepOffscreen'),
    scrollToOldest: () => defer('scrollToOldest'),
    scrollToLive: () => defer('scrollToLive'),
    openHelp: () => defer('openHelp'),
    closeHelp: () => defer('closeHelp'),
    assertColored: () => defer('assertColored'),
    assertAbsent: () => defer('assertAbsent'),
    assertNoCaretEcho: () => defer('assertNoCaretEcho'),
  }
}

async function readPersistedStatus(handle: OrchHandle): Promise<string | undefined> {
  const raw = await readFile(`${handle.stateDir}/state.json`, 'utf-8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    return (JSON.parse(raw) as { status?: string }).status
  } catch {
    return undefined
  }
}

function createLifecycleApp(leakBaseline: number): LifecycleApp {
  let handle: OrchHandle | undefined

  const requireHandle = (): OrchHandle => {
    if (handle === undefined) throw new Error(`${DRIVER_LABEL}: launch(spec) must run first`)
    return handle
  }

  const system: SystemAssertionsBackend = {
    exitedNormally: () =>
      assertOrchExits(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), exitedNormallyMatcher()),
    tmuxTornDown: () =>
      assertTmuxSession(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), tmuxIsTornDownMatcher()),
    async persistedStatus(status: PersistedStatus): Promise<void> {
      const h = requireHandle()
      const deadline = Date.now() + REAL_TMUX_ASSERT_TIMEOUT_MS
      let last: string | undefined
      for (;;) {
        last = await readPersistedStatus(h)
        if (last === status) return
        // A terminal status that differs will never change — fail fast.
        if (last !== undefined && TERMINAL_STATUSES.has(last) && last !== status) break
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, PERSISTED_STATUS_POLL_MS))
      }
      throw new Error(
        `${DRIVER_LABEL}: persistedStatus expected ${JSON.stringify(status)} but state.json status is ${JSON.stringify(last ?? '(none)')}`,
      )
    },
  }

  return {
    async launch(spec: LifecycleSpec): Promise<void> {
      const fixtureName = resolveFixtureName(spec.steps)
      const plan = planLaunch(spec)
      handle = await launchOrchWorkflow(fixtureName, {
        script: plan.script,
        bringToState: plan.bringToState,
      })
    },

    press(pane: 'left' | 'right', key: string): Promise<void> {
      requireHandle()
      // `f` (snap-to-live) is idempotent — poll-and-resend until the selection
      // lands on the live step, defeating the dropped-first-keypress race
      // (REGRESSION 2026-05-29 nav.f-snaps). Other keys are fire-and-forget;
      // their observable transition is polled by the following assertion.
      if (key === 'f') return userAction(snapToLive())
      return userAction(pressKeyInPane(pane, key))
    },

    signal(sig: Signal): Promise<void> {
      requireHandle()
      return userAction(signalOrch(sig))
    },

    leftPane: new LeftPane(deferredPaneDriver()),
    rightPane: new RightPane(deferredPaneDriver()),
    system: new SystemAssertions(system),

    async teardown(): Promise<void> {
      await handle?.teardown()
      handle = undefined
      // Turn a leaked puppet into a loud failure (parent R1, the named flake).
      await assertNoLeakedEntries(leakBaseline)
    },
  }
}

async function build(_meta: ScenarioMeta<readonly DriverName[]>): Promise<LifecycleApp> {
  const leakBaseline = await scriptedFakeEntryCount()
  return createLifecycleApp(leakBaseline)
}

export const lifecycleDriver: Driver<LifecycleApp> = {
  build,
  skip: () => !canRunRealTmux(),
  timeout: REAL_TMUX_TEST_TIMEOUT_MS,
}
