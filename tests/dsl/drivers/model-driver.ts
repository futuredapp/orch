// ---------------------------------------------------------------------------
// model driver — controller decisions / projection seam, NO tmux (the bulk).
// ---------------------------------------------------------------------------
//
// Builds a `ModelApp` over the steps-view Ink-render projection seam (today's
// Tier-2 approach): render `<StepsView>` via a configurable ink harness, drive
// its input, and inspect `lastFrame()`. Assertions read the PROJECTED/RENDERED
// view-model — what the controller DECIDED to show — never a fake tmux. It
// allocates no socket and boots no tmux (R5).
//
// Most assertions run over the ANSI-STRIPPED frame; colour assertions (D-P4)
// run over the RAW frame, where Ink's SGR escapes are still present. Navigation
// (selection, preview cursor, scroll, snap-to-live) is driven by REAL keystrokes
// written to the harness stdin, so the genuine hooks run — except `selectStep`,
// which commits via the same intent a real `Enter` produces.

import { pressUntilFrame, waitForFrame } from '@orch/test/ink-frame.ts'
import chalk from 'chalk'
import { createElement } from 'react'
import type {
  RunHeader,
  StepRow,
  StepsViewState,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import { retryUntil } from '../../_support/retry.ts'
import type { DriverName, ModelApp, ModelSpec } from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import { CARET_ECHO_TOKENS, type PaneDriver } from '../panes/pane-driver.ts'
import type { ScenarioMeta } from '../scenario.ts'
import {
  ARROW_DOWN,
  ARROW_UP,
  computeArrowDirection,
  ESCAPE,
  frameHasColoredText,
  frameHasFullWidthBand,
  glyphChar,
  highlightedStepName,
  occurrences,
  previewCursorStepName,
  rowHasGlyph,
  rowVisible,
  stripAnsi,
} from './frame-text.ts'
import { createVirtualClock, type HarnessApi, ModelHarness } from './model-harness.tsx'
import { type ModelInkHarness, renderModel } from './model-ink-harness.ts'
import type { Driver } from './registry.ts'

// Deterministic clock for `<StepRow>` elapsed math — keeps frames stable.
const NOW = 5_000
const MODEL_TIMEOUT_MS = 10_000
const RUN: RunHeader = { runId: 'r-2026-06-05-000000-u1', workflowName: 'demo', startedAt: 0 }

function buildBaseState(spec: ModelSpec): StepsViewState {
  const last = spec.steps.length - 1
  const failed =
    spec.stopAt === 'end-of-run' && spec.outcome !== undefined && spec.outcome !== 'completed'
  const steps: StepRow[] = spec.steps.map((name, i) => {
    if (spec.stopAt === 'mid-step' && i === last) {
      return { kind: 'agent', mode: 'autonomous', status: 'running', name, startedAt: i * 1_000 }
    }
    const status = failed && i === last ? 'failed' : 'completed'
    return {
      kind: 'agent',
      mode: 'autonomous',
      status,
      name,
      startedAt: i * 1_000,
      endedAt: i * 1_000 + 500,
    }
  })
  const view = { mode: 'live' } as const
  if (spec.stopAt === 'end-of-run') {
    const summary = {
      endedAt: steps.length * 1_000,
      durationMs: steps.length * 1_000,
      stepsTotal: steps.length,
      stepsCompleted: failed ? steps.length - 1 : steps.length,
      stepsFailed: failed ? 1 : 0,
    }
    const status = spec.outcome === 'crashed' ? 'crashed' : failed ? 'failed' : 'completed'
    return { status, summary, run: RUN, steps, view }
  }
  return { status: 'live', run: RUN, steps, view }
}

// `follow-live` snaps to the running step (mid-step) or the last step otherwise.
function computeLiveName(spec: ModelSpec): string | undefined {
  return spec.steps[spec.steps.length - 1]
}

function createModelApp(): ModelApp {
  let ui: ModelInkHarness | undefined
  let api: HarnessApi | undefined
  const clock = createVirtualClock()
  let stepNames: readonly string[] = []
  let liveName: string | undefined

  const requireUi = (): ModelInkHarness => {
    if (ui === undefined) {
      throw new Error('model driver: launch(spec) must be called before any assertion')
    }
    return ui
  }
  const requireApi = (): HarnessApi => {
    if (api === undefined) throw new Error('model driver: harness api not ready')
    return api
  }
  const strip = { transform: stripAnsi }

  // Move the preview cursor toward `step` with real arrow keys, re-reading the
  // frame each move so a dropped keystroke self-corrects (the ink useInput race).
  async function moveCursorTo(step: string): Promise<void> {
    const instance = requireUi()
    const target = stepNames.indexOf(step)
    if (target === -1)
      throw new Error(`model driver: browseTo(${JSON.stringify(step)}) — no such step`)
    let budget = stepNames.length * 2 + 8
    for (;;) {
      const frame = stripAnsi(instance.lastFrame() ?? '')
      const current =
        previewCursorStepName(frame, stepNames) ?? highlightedStepName(frame, stepNames)
      const direction = computeArrowDirection(current, step, stepNames)
      if (direction === 'done') return
      if (budget-- <= 0) {
        throw new Error(
          `model driver: browseTo(${JSON.stringify(step)}) stuck at ${JSON.stringify(current)}`,
        )
      }
      instance.stdin.write(direction === 'down' ? ARROW_DOWN : ARROW_UP)
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  const paneDriver: PaneDriver = {
    async assertBottomText(literal, { count }): Promise<void> {
      await waitForFrame(requireUi(), (f) => occurrences(f, literal) === count, strip)
    },
    async assertContains(text): Promise<void> {
      await waitForFrame(requireUi(), (f) => f.includes(text), strip)
    },
    async assertSelected(step): Promise<void> {
      await waitForFrame(requireUi(), (f) => highlightedStepName(f, stepNames) === step, strip)
    },
    async assertGlyph(step, glyph): Promise<void> {
      const wanted = glyphChar(glyph)
      await waitForFrame(requireUi(), (f) => rowHasGlyph(f, step, wanted), strip)
    },
    async selectStep(step): Promise<void> {
      requireApi().dispatch({ type: 'enter', stepName: step })
      await waitForFrame(requireUi(), (f) => highlightedStepName(f, stepNames) === step, strip)
    },
    async followLive(): Promise<void> {
      const target = liveName
      if (target === undefined) throw new Error('model driver: spec has no live step to follow')
      await pressUntilFrame(
        requireUi(),
        'f',
        (f) => highlightedStepName(f, stepNames) === target,
        strip,
      )
    },
    async browseTo(step): Promise<void> {
      await moveCursorTo(step)
      await waitForFrame(requireUi(), (f) => previewCursorStepName(f, stepNames) === step, strip)
    },
    async assertPreviewCursorOn(step): Promise<void> {
      await waitForFrame(requireUi(), (f) => previewCursorStepName(f, stepNames) === step, strip)
    },
    async assertStepVisible(step): Promise<void> {
      await waitForFrame(requireUi(), (f) => rowVisible(f, step), strip)
    },
    async assertStepOffscreen(step): Promise<void> {
      await waitForFrame(requireUi(), (f) => !rowVisible(f, step), strip)
    },
    async openHelp(marker): Promise<void> {
      // `?` toggles, so resending is safe ONLY while the overlay is still hidden
      // (a dropped first keypress). Re-read before each resend; never blind-spam.
      const instance = requireUi()
      const matched = await retryUntil(
        () => {
          instance.stdin.write('?')
        },
        () => stripAnsi(instance.lastFrame() ?? '').includes(marker),
        { maxAttempts: 5, perAttemptMs: 20 },
      )
      if (!matched) await waitForFrame(instance, (f) => f.includes(marker), strip)
    },
    async closeHelp(marker): Promise<void> {
      // Esc on a closed overlay is a no-op (or banner-dismiss), never a re-open,
      // so it is safe to resend until the overlay disappears.
      const instance = requireUi()
      const matched = await retryUntil(
        () => {
          instance.stdin.write(ESCAPE)
        },
        () => !stripAnsi(instance.lastFrame() ?? '').includes(marker),
        { maxAttempts: 5, perAttemptMs: 20 },
      )
      if (!matched) await waitForFrame(instance, (f) => !f.includes(marker), strip)
    },
    async scrollToOldest(): Promise<void> {
      const oldest = stepNames[0]
      if (oldest === undefined) return
      await pressUntilFrame(requireUi(), 'g', (f) => rowVisible(f, oldest), strip)
    },
    async scrollToLive(): Promise<void> {
      const live = stepNames[stepNames.length - 1]
      if (live === undefined) return
      await pressUntilFrame(requireUi(), 'G', (f) => rowVisible(f, live), strip)
    },
    async assertColored(lineNeedle, colorName): Promise<void> {
      // Colour lives in the RAW frame (Ink SGR escapes), so do not strip here.
      await waitForFrame(requireUi(), (f) => frameHasColoredText(f, lineNeedle, colorName))
    },
    async assertRowBandFills(lineNeedle, bgColorName, minTrailingPad): Promise<void> {
      // The band lives in the RAW frame (Ink SGR escapes), so do not strip here.
      await waitForFrame(requireUi(), (f) =>
        frameHasFullWidthBand(f, lineNeedle, bgColorName, minTrailingPad),
      )
    },
    async assertAbsent(text): Promise<void> {
      await waitForFrame(requireUi(), (f) => !f.includes(text), strip)
    },
    // Catches Ink rendering escape leakage (Ink accidentally encoding escape sequences
    // as literal text like "^[", "^M"). This is NOT a pty/tmux escape-doubling check —
    // pty doubling requires a real TTY and must run on a screen or full-host driver (spec §5.7).
    async assertNoCaretEcho(): Promise<void> {
      const frame = stripAnsi(requireUi().lastFrame() ?? '')
      const offender = CARET_ECHO_TOKENS.find((token) => frame.includes(token))
      if (offender !== undefined) {
        throw new Error(`model driver: rendered frame unexpectedly contains caret echo ${offender}`)
      }
    },
  }

  const leftPane = new LeftPane(paneDriver)

  return {
    async launch(spec): Promise<void> {
      // A scenario may re-launch (e.g. completed → failed → crashed); unmount the
      // prior instance so only the latest harness is live.
      ui?.unmount()
      api = undefined
      stepNames = spec.steps
      liveName = computeLiveName(spec)
      const base = buildBaseState(spec)
      const initialBanner =
        spec.banner !== undefined
          ? { kind: spec.banner.kind, text: spec.banner.text, seq: 1 }
          : undefined
      const instance = renderModel(
        createElement(ModelHarness, {
          base,
          now: NOW,
          clock,
          ...(initialBanner !== undefined ? { initialBanner } : {}),
          onApi: (a) => {
            api = a
          },
        }),
        spec.viewportRows !== undefined ? { rows: spec.viewportRows } : {},
      )
      ui = instance
      await waitForFrame(instance, (f) => f.length > 0)
    },
    leftPane,
    async emitBanner(level, text): Promise<void> {
      requireApi().emitBanner(level, text)
      await waitForFrame(requireUi(), (f) => f.includes(text), strip)
    },
    async advanceTime(ms): Promise<void> {
      clock.advance(ms)
    },
    async teardown(): Promise<void> {
      ui?.unmount()
      ui = undefined
      api = undefined
      stepNames = []
      liveName = undefined
    },
  }
}

export const modelDriver: Driver<ModelApp> = {
  build: (_meta: ScenarioMeta<readonly DriverName[]>): Promise<ModelApp> => {
    // Bun reports `isTTY === false`, so chalk defaults to level 0 and Ink emits
    // NO ANSI — making the D-P4 colour assertions vacuous. Force truecolor at
    // build time (a runtime side effect, not an import-time one) so the rendered
    // frame carries real SGR escapes. Harmless to the stripped-frame assertions.
    chalk.level = 3
    return Promise.resolve(createModelApp())
  },
  skip: () => false,
  timeout: MODEL_TIMEOUT_MS,
}
