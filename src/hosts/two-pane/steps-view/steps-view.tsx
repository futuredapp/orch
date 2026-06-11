// ---------------------------------------------------------------------------
// <StepsView> — Ink composition root for the two-pane left pane.
// ---------------------------------------------------------------------------
//
// Renders a `StepsViewState` plus user-driven selection. The pieces live in
// sibling files so each stays under the 300-line ceiling:
//   - `steps-view-keymap.ts`  — PURE key → action resolution (the whole keymap)
//   - `step-row.tsx`          — `<StepRow>` / `<SubBoundaryRow>` / `<ParallelGroup>`
//   - `steps-view-banner.tsx` — `<BannerBox>` + the info-banner TTL constant
//   - `steps-view-header.tsx` — `<LiveHeader>` + chrome height estimation
//   - `steps-view-footer.tsx` — `<ViewModeFooter>`
//   - `help-overlay.tsx`      — `<HelpOverlay>`
//   - `steps-view-hooks.ts`   — selection / scroll / adaptive-columns hooks
//
// Hooks: `useAdaptiveColumns(stdout)` (width → ColumnSet), `useStepsSelection`
// (the COMMITTED highlight tracks `state.view` so the left pane always points
// at what the right pane shows — Issue 2; `↑/↓` drive a separate PREVIEW
// cursor committed on `⏎`), `useStepsScroll` (absolute-anchored viewport).

import { Box, Text, useInput, useStdout } from 'ink'
import type React from 'react'
import { useEffect, useState } from 'react'
import { EndOfRunFooter, EndOfRunSummary } from './end-of-run-summary.tsx'
import { HelpOverlay } from './help-overlay.tsx'
import { StepRow, SubBoundaryRow } from './step-row.tsx'
import type { StepsViewState } from './step-types.ts'
import { BannerBox, bannerText, DEFAULT_INFO_TTL_MS } from './steps-view-banner.tsx'
import { ViewModeFooter } from './steps-view-footer.tsx'
import { isSelectableRow, rowKey } from './steps-view-format.ts'
import { estimateHeaderRows, LiveHeader } from './steps-view-header.tsx'
import { useAdaptiveColumns, useStepsScroll, useStepsSelection } from './steps-view-hooks.ts'
import {
  classifyKey,
  resolveStepsKeyAction,
  type StepsKeyAction,
  type StepsKeyTag,
} from './steps-view-keymap.ts'
import {
  computeVisibleCount,
  estimateWrappedRows,
  scrollbarTrack,
  visibleSlice,
} from './steps-view-layout.ts'

export { HelpOverlay } from './help-overlay.tsx'
export type { ParallelGroupProps } from './step-row.tsx'
export { ParallelGroup } from './step-row.tsx'
export type { StepsScroll, StepsSelection } from './steps-view-hooks.ts'
export { useAdaptiveColumns, useStepsScroll, useStepsSelection } from './steps-view-hooks.ts'

// Stable module-scope default so the auto-dismiss `useEffect` does not re-arm
// the timer on every render (the effect lists `scheduleDismiss` in its deps).
const defaultScheduleDismiss = (callback: () => void, ms: number): (() => void) => {
  const handle = setTimeout(callback, ms)
  return () => {
    clearTimeout(handle)
  }
}

export interface StepsViewProps {
  readonly state: StepsViewState
  readonly onIntent: (intent: StepsViewIntent) => void
  /**
   * `now()` — used by `<StepRow>` to compute elapsed for live steps. Default
   * `Date.now`. Threading it through props keeps tests deterministic.
   */
  readonly now?: () => number
  /**
   * Schedules the info-banner auto-dismiss; returns a cancel fn. Defaults to
   * `setTimeout`/`clearTimeout`. Threaded through props (like `now`) so tests
   * can drive the timer deterministically instead of racing real wall-clock —
   * the banner auto-dismiss flake, 2026-05-26. MUST be a stable reference
   * across renders, or the keyed `useEffect` re-arms the timer every render.
   */
  readonly scheduleDismiss?: (callback: () => void, ms: number) => () => void
  /**
   * Optional diagnostic sink: invoked once per Ink keypress with a tagged
   * record. The runner wires this to an NDJSON IPC file so the parent can log
   * keystrokes (debug-only) — without this hook, keypresses inside the Ink
   * child are invisible to anyone debugging the input → intent chain.
   * Default no-op.
   */
  readonly onKey?: (event: StepsViewKeyEvent) => void
  /**
   * U6: enable the interactive failure-view actions (`[r]` retry, `[c]`
   * retry-and-continue). Only the CLI re-entry `failed` open sets this; a
   * live run's failure frame leaves it `false` so the actions never surface
   * there (that is the sibling feature, out of scope). Inert unless the run's
   * `status === 'failed'`.
   */
  readonly actionsEnabled?: boolean
}

export type StepsViewIntent =
  | { readonly type: 'enter'; readonly stepName: string }
  | { readonly type: 'follow-live' }
  | { readonly type: 'quit' }
  | { readonly type: 'dismiss-banner' }
  // U5/U6: retry actions, emitted only from the interactive failure view (when
  // `actionsEnabled` is set on a `failed` run). `[r]` re-runs the failed step
  // once and re-parks; `[c]` re-runs it and continues to completion.
  | { readonly type: 'retry' }
  | { readonly type: 'retry-continue' }

export interface StepsViewKeyEvent {
  readonly ts: number
  readonly key: StepsKeyTag
  /** Raw input character when `key === 'other'`. Empty string otherwise. */
  readonly input: string
  readonly selectedName: string | undefined
  readonly isUserDriven: boolean
  readonly helpOpen: boolean
}

export function StepsView({
  state,
  onIntent,
  now = Date.now,
  scheduleDismiss = defaultScheduleDismiss,
  onKey,
  actionsEnabled = false,
}: StepsViewProps): React.ReactElement {
  // Failure actions are live only in the interactive `failed` re-entry view.
  const failureActions = actionsEnabled && state.status === 'failed'
  const columns = useAdaptiveColumns()
  const { stdout } = useStdout()
  const { committedName, selectedName, moveUp, moveDown, snapToLive, isUserDriven } =
    useStepsSelection(state.steps, state.view)
  const [helpOpen, setHelpOpen] = useState(false)

  // Visible-row budget for the steps body. The frame must stay below the
  // pane viewport or Ink full-clears (a visible blank-then-repaint) on every
  // render — so the chrome envelope is measured against the actual wrapped
  // height of the header/banner/footer rather than a flat constant. See
  // `steps-view-layout.ts`.
  const paneCols = stdout?.columns ?? 80
  const paneRows = stdout?.rows ?? 24
  const visibleCount = computeVisibleCount(paneRows, {
    headerRows: estimateHeaderRows(state, paneCols),
    bannerRows:
      state.banner !== undefined ? estimateWrappedRows(bannerText(state.banner), paneCols) : 0,
    footerRows: 1,
  })

  const scroll = useStepsScroll(state.steps.length, visibleCount, () => {
    onIntent({ type: 'follow-live' })
  })

  const runAction = (action: StepsKeyAction): void => {
    switch (action.type) {
      case 'close-help':
        setHelpOpen(false)
        return
      case 'open-help':
        setHelpOpen(true)
        return
      case 'dismiss-banner':
        onIntent({ type: 'dismiss-banner' })
        return
      case 'scroll':
        runScroll(scroll, action.to)
        return
      case 'move-selection':
        if (action.dir === 'up') moveUp()
        else moveDown()
        return
      case 'commit-selection': {
        if (selectedName === undefined) return
        // R24 defensive guard: selection-skip should already prevent the
        // preview cursor from landing on a boundary row, but a fixture or
        // scroll-window cut could still expose one. Enter on a boundary is a
        // no-op — no intent, no info banner (the brainstorm's AE10 "optionally"
        // wording was dropped so two implementers cannot diverge).
        const target = state.steps.find((s) => s.name === selectedName)
        if (target !== undefined && isSelectableRow(target)) {
          onIntent({ type: 'enter', stepName: selectedName })
        }
        return
      }
      case 'follow-live':
        snapToLive()
        onIntent({ type: 'follow-live' })
        return
      case 'retry':
        onIntent({ type: 'retry' })
        return
      case 'retry-continue':
        onIntent({ type: 'retry-continue' })
        return
      case 'quit':
        // Ctrl-C inside the Ink pane: orch's stdin is `pipe`, so the kernel
        // never converts `\x03` to SIGINT (no controlling TTY). Ink surfaces
        // it as `key.ctrl && input === 'c'`; the keymap routes it to the same
        // quit intent as `q` so the CLI's foreground-shutdown race tears orch
        // down.
        onIntent({ type: 'quit' })
        return
      case 'none':
        return
    }
  }

  useInput((input, key) => {
    const tag = classifyKey(input, key)
    onKey?.({
      ts: Date.now(),
      key: tag,
      input: tag === 'other' ? input : '',
      selectedName,
      isUserDriven,
      helpOpen,
    })
    runAction(
      resolveStepsKeyAction(input, key, {
        helpOpen,
        hasErrorBanner: state.banner !== undefined && state.banner.kind === 'error',
        failureActions,
      }),
    )
  })

  // Info-banner auto-dismiss. The controller emits a new banner OBJECT for
  // every snapshot (different seq → different reference), so depending on
  // `banner` is sufficient to fire this effect once per emit. Successive info
  // banners with identical text still re-arm the timer because the parent's
  // monotonic `seq` makes the banner object a fresh reference each time.
  // Error banners do not auto-dismiss regardless of `ttlMs`.
  const banner = state.banner
  useEffect(() => {
    if (banner === undefined || banner.kind !== 'info') return
    const cancel = scheduleDismiss(() => {
      onIntent({ type: 'dismiss-banner' })
    }, banner.ttlMs ?? DEFAULT_INFO_TTL_MS)
    return cancel
  }, [banner, onIntent, scheduleDismiss])

  const isTerminal = state.status !== 'live'

  return (
    <Box flexDirection="column">
      {isTerminal ? (
        <EndOfRunSummary run={state.run} summary={state.summary} status={state.status} />
      ) : (
        <LiveHeader state={state} now={now()} />
      )}
      {banner !== undefined ? <BannerBox banner={banner} /> : null}
      {state.steps.length === 0 ? (
        <Text dimColor>(no steps yet)</Text>
      ) : (
        // Ink 7 defaults all four edges to `true` when `borderStyle` is set,
        // so the side edges must be explicitly disabled to avoid doubling
        // against the tmux pane border (R1).
        <Box
          flexDirection="row"
          borderStyle="single"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        >
          <Box flexDirection="column" flexGrow={1}>
            {visibleSlice(state.steps, scroll.scrollOffset, visibleCount).map((step) =>
              step.kind === 'subworkflow-enter' || step.kind === 'subworkflow-exit' ? (
                <SubBoundaryRow key={rowKey(step)} row={step} paneCols={paneCols} />
              ) : (
                <StepRow
                  key={rowKey(step)}
                  step={step}
                  columns={columns}
                  now={now()}
                  selected={step.name === committedName}
                  preview={
                    isUserDriven && step.name === selectedName && step.name !== committedName
                  }
                  paneCols={paneCols}
                />
              ),
            )}
          </Box>
          {state.steps.length > visibleCount ? (
            <Box flexDirection="column" width={1} flexShrink={0}>
              {scrollbarTrack(state.steps.length, scroll.scrollOffset, visibleCount).map(
                (char, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the track is positional by definition
                  <Text key={i} color={char === '█' ? 'cyan' : undefined} dimColor={char !== '█'}>
                    {char}
                  </Text>
                ),
              )}
            </Box>
          ) : null}
        </Box>
      )}
      {isTerminal ? (
        <EndOfRunFooter status={state.status} showFailureActions={failureActions} />
      ) : null}
      {!helpOpen && !isTerminal ? (
        <ViewModeFooter
          view={state.view}
          scrollOffset={scroll.scrollOffset}
          totalSteps={state.steps.length}
          visibleCount={visibleCount}
        />
      ) : null}
      {helpOpen ? <HelpOverlay /> : null}
    </Box>
  )
}

function runScroll(
  scroll: ReturnType<typeof useStepsScroll>,
  to: 'up' | 'down' | 'page-up' | 'page-down' | 'top' | 'bottom',
): void {
  if (to === 'up') scroll.scrollUp()
  else if (to === 'down') scroll.scrollDown()
  else if (to === 'page-up') scroll.pageUp()
  else if (to === 'page-down') scroll.pageDown()
  else if (to === 'top') scroll.jumpTop()
  else scroll.jumpBottom()
}
