// ---------------------------------------------------------------------------
// Shared STATIC full-host app factory — the one full-host engine, reused.
// ---------------------------------------------------------------------------
//
// Every non-live full-host fidelity (fake-agent static default, recorded-agent
// cassette replay, real-agent) drives the SAME two-pane host on real tmux and
// differs only in WHICH Runner sits in each step's agent slot (parent §5.6,
// §9.5/§9.6/§9.7; this plan D-P3.2/D-P3.3). That single axis of variation is the
// `agentForStep` callback; everything else — pane objects, the run promise, the
// teardown order — lives here so the recorded/real drivers never copy-paste the
// fake-agent wiring (parent §11 north star, risk P3-C).
//
// The live-driven scriptedFake submode is NOT served here — it is intrinsically
// fake-agent-only (subprocess puppet + leak sentinel) and stays in
// `full-host-fake-agent-driver.ts`.

import {
  type MountedHarness,
  type PaneHandle,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  type RealTmuxFixture,
} from '@orch/test/real-tmux/index.ts'
import type { Runner } from '../../../src/runners/index.ts'
import type { FullHostApp, FullHostSpec } from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import { RightPane } from '../panes/right-pane.ts'
import { createRealTmuxPaneDriver } from './real-tmux-pane-driver.ts'

/** What an agent-slot builder hands back for one step. */
export interface StepAgent {
  readonly agent: Runner
  /** Forwarded to the runner (real-agent carries a prompt; fakes do not). */
  readonly prompt?: string
  /** Orch-injected fragment appended via the `extraPrompt` override (AT-8). */
  readonly extraPrompt?: string
}

/** Builds the agent that drives a given step — the only axis that varies. */
export type AgentForStep = (name: string, index: number, spec: FullHostSpec) => StepAgent

export interface StaticFullHostDeps {
  readonly fixture: RealTmuxFixture
  readonly harness: MountedHarness
  /** Driver label, surfaced in pane-driver error messages. */
  readonly label: string
  readonly agentForStep: AgentForStep
}

/**
 * Build a static (non-live) `FullHostApp`. `launch` runs the whole workflow to
 * completion against the host; `complete` awaits it; `teardown` reaps host →
 * run promise → fixture in the canonical order.
 */
export function createStaticFullHostApp(deps: StaticFullHostDeps): FullHostApp {
  const { fixture, harness, label, agentForStep } = deps
  let stepNames: readonly string[] = []
  let runPromise: Promise<unknown> | undefined

  const paneDeps = (handle: PaneHandle) =>
    createRealTmuxPaneDriver({
      handle,
      stepNames: () => stepNames,
      assertTimeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
      driverLabel: label,
      // Navigation always drives the steps (left) pane; `sendKeys` targets it.
      sendKey: (input) => harness.sendKeys(input),
      // Server-wide paste-buffer reader for the AT-6 clipboard assertion.
      clipboard: { tmux: fixture.tmux, socket: fixture.socket },
    })

  const leftPane = new LeftPane(paneDeps(harness.left))
  const rightPane = new RightPane(paneDeps(harness.right))

  return {
    async launch(spec: FullHostSpec): Promise<void> {
      stepNames = spec.steps
      const steps = spec.steps.map((name, index) => {
        const built = agentForStep(name, index, spec)
        // `mode`/`autoStop` are run-level (W1): forwarded to every step when set,
        // omitted otherwise so existing fake/recorded scenarios are unchanged.
        return {
          name,
          agent: built.agent,
          ...(built.prompt !== undefined ? { prompt: built.prompt } : {}),
          ...(built.extraPrompt !== undefined ? { extraPrompt: built.extraPrompt } : {}),
          ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
          ...(spec.autoStop !== undefined ? { autoStop: spec.autoStop } : {}),
        }
      })
      runPromise = harness.runWorkflow(steps)
      // Never leave the run promise unobserved — that would surface as an
      // unhandled rejection if the workflow errors before complete/teardown.
      runPromise.catch(() => {})
    },

    async complete(_step: string): Promise<void> {
      // The whole FakeRunner/real workflow already runs to completion; await it.
      await runPromise?.catch(() => {})
    },

    leftPane,
    rightPane,

    async teardown(): Promise<void> {
      await harness.teardown()
      await runPromise?.catch(() => {})
      await fixture.dispose()
    },
  }
}
