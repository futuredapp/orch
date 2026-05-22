// ---------------------------------------------------------------------------
// <StepsView> — Ink components for the two-pane left pane.
// ---------------------------------------------------------------------------
//
// Renders a `StepsViewState` plus user-driven selection. Hooks:
//   - `useAdaptiveColumns(stdout)` — width → ColumnSet (debounced re-render)
//   - `useStepsSelection(steps)`  — sticky-on-stepName selection w/ ↑/↓/f
//
// Keymap: `↑/↓` move selection · `⏎` fire intent · `f` snap-to-live ·
// `Esc` close help / dismiss error banner · `?` help overlay · `q` quit ·
// `Ctrl-C` quit (same quit-intent as `q`; routed by the CLI to teardown).
//
// View-mode footer: when `state.view.mode === 'live'` the footer reads
// `▶ live · …`; when `'replay'` it reads `⏸ viewing <stepName> · f live · …`.
// `state.banner` (when present) renders as a single-line box above the steps
// grid. Info banners auto-clear after `ttlMs ?? 4000` via a `useEffect` keyed
// on `banner.seq` so rapid identical-text emits restart the timer. Error
// banners persist until replaced by a new emit or dismissed with `Esc`
// (precedence: help-close > dismiss-banner > no-op).
//
// `<StepRow>` is `React.memo`'d with threshold-bucketed prop equality so a
// flood of viewmodel changes (10/sec on a hot step) doesn't redraw every row.

import { Box, Text, useInput, useStdout } from 'ink'
import type React from 'react'
import { memo, useEffect, useState } from 'react'
import { formatElapsed, stepGlyphView, stripAnsi } from '../../../observability/index.ts'
import type { ColumnSet } from './adaptive-columns.ts'
import { EndOfRunFooter, EndOfRunSummary } from './end-of-run-summary.tsx'
import type { Banner, StepRow as StepRowData, StepsViewState, ViewMode } from './step-types.ts'
import { useAdaptiveColumns, useStepsScroll, useStepsSelection } from './steps-view-hooks.ts'

export type { StepsScroll, StepsSelection } from './steps-view-hooks.ts'
export { useAdaptiveColumns, useStepsScroll, useStepsSelection } from './steps-view-hooks.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INFO_TTL_MS = 4000
const STEP_NAME_MAX = 30

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface StepsViewProps {
  readonly state: StepsViewState
  readonly onIntent: (intent: StepsViewIntent) => void
  /**
   * `now()` — used by `<StepRow>` to compute elapsed for live steps. Default
   * `Date.now`. Threading it through props keeps tests deterministic.
   */
  readonly now?: () => number
  /**
   * Optional diagnostic sink: invoked once per Ink keypress with a tagged
   * record. The runner wires this to an NDJSON IPC file so the parent can log
   * keystrokes (debug-only) — without this hook, keypresses inside the Ink
   * child are invisible to anyone debugging the input → intent chain.
   * Default no-op.
   */
  readonly onKey?: (event: StepsViewKeyEvent) => void
}

export type StepsViewIntent =
  | { readonly type: 'enter'; readonly stepName: string }
  | { readonly type: 'follow-live' }
  | { readonly type: 'quit' }
  | { readonly type: 'dismiss-banner' }

export interface StepsViewKeyEvent {
  readonly ts: number
  readonly key:
    | 'up'
    | 'down'
    | 'return'
    | 'f'
    | 'q'
    | '?'
    | 'esc'
    | 'ctrl-c'
    | 'j'
    | 'k'
    | 'pageUp'
    | 'pageDown'
    | 'home'
    | 'end'
    | 'other'
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
  onKey,
}: StepsViewProps): React.ReactElement {
  const columns = useAdaptiveColumns()
  const { stdout } = useStdout()
  const { selectedName, moveUp, moveDown, snapToLive, isUserDriven } = useStepsSelection(
    state.steps,
  )
  const [helpOpen, setHelpOpen] = useState(false)

  // Visible-row budget for the steps body. Subtracts a rough chrome envelope
  // (header line, two single-pixel borders, footer + margin, optional banner).
  // The exact number is forgiving — scrollOffset is clamped at read time, so
  // an over- or under-estimate of one row just shifts where the "top" lands.
  const chromeRows = 5 + (state.banner !== undefined ? 1 : 0)
  const visibleCount = Math.max(1, (stdout?.rows ?? 24) - chromeRows)

  const scroll = useStepsScroll(state.steps.length, visibleCount, () => {
    onIntent({ type: 'follow-live' })
  })

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
    if (helpOpen) {
      if (key.escape || input === '?') {
        setHelpOpen(false)
      }
      return
    }
    if (key.escape) {
      // Esc precedence (help already handled above): dismiss an error banner,
      // otherwise no-op. Info banners auto-clear and are not manually
      // dismissable — that matches the brainstorm's single-slot semantics.
      if (state.banner !== undefined && state.banner.kind === 'error') {
        onIntent({ type: 'dismiss-banner' })
      }
      return
    }
    // Scroll keys before selection keys so j/k/PgUp/PgDn/Home/End cannot be
    // shadowed by arrow-key selection movement on terminals that report the
    // arrow keys with the same legacy escape sequence.
    if (input === 'k') {
      scroll.scrollUp()
      return
    }
    if (input === 'j') {
      scroll.scrollDown()
      return
    }
    if (key.pageUp === true) {
      scroll.pageUp()
      return
    }
    if (key.pageDown === true) {
      scroll.pageDown()
      return
    }
    if (key.home === true || input === 'g') {
      scroll.jumpTop()
      return
    }
    if (key.end === true || input === 'G') {
      scroll.jumpBottom()
      return
    }
    if (key.upArrow) {
      moveUp()
      return
    }
    if (key.downArrow) {
      moveDown()
      return
    }
    if (key.return) {
      if (selectedName !== undefined) {
        onIntent({ type: 'enter', stepName: selectedName })
      }
      return
    }
    if (input === 'f' || input === 'F') {
      snapToLive()
      onIntent({ type: 'follow-live' })
      return
    }
    // Ctrl-C inside the Ink pane: orch's stdin is `pipe`, so the kernel never
    // converts `\x03` to SIGINT (no controlling TTY). Ink surfaces it as
    // `key.ctrl && input === 'c'`; route to the same quit intent as `q` so
    // the CLI's foreground-shutdown race tears orch down.
    if (key.ctrl === true && (input === 'c' || input === 'C')) {
      onIntent({ type: 'quit' })
      return
    }
    if (input === 'q') {
      onIntent({ type: 'quit' })
      return
    }
    if (input === '?') {
      setHelpOpen(true)
    }
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
    const handle = setTimeout(() => {
      onIntent({ type: 'dismiss-banner' })
    }, banner.ttlMs ?? DEFAULT_INFO_TTL_MS)
    return () => {
      clearTimeout(handle)
    }
  }, [banner, onIntent])

  const isTerminal = state.status !== 'live'

  return (
    <Box flexDirection="column">
      {isTerminal ? (
        <EndOfRunSummary run={state.run} summary={state.summary} status={state.status} />
      ) : (
        <Text>{renderHeader(state)}</Text>
      )}
      {banner !== undefined ? <BannerBox banner={banner} /> : null}
      {state.steps.length === 0 ? (
        <Text dimColor>(no steps yet)</Text>
      ) : (
        // Ink 7 defaults all four edges to `true` when `borderStyle` is set,
        // so the side edges must be explicitly disabled to avoid doubling
        // against the tmux pane border (R1).
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        >
          {visibleSlice(state.steps, scroll.scrollOffset, visibleCount).map((step) => (
            <StepRow
              key={step.name}
              step={step}
              columns={columns}
              now={now()}
              selected={step.name === selectedName && isUserDriven}
            />
          ))}
        </Box>
      )}
      {isTerminal ? <EndOfRunFooter status={state.status} /> : null}
      {!helpOpen && !isTerminal ? (
        <ViewModeFooter view={state.view} scrollOffset={scroll.scrollOffset} />
      ) : null}
      {helpOpen ? <HelpOverlay /> : null}
    </Box>
  )
}

function visibleSlice(
  steps: readonly StepRowData[],
  scrollOffset: number,
  visibleCount: number,
): readonly StepRowData[] {
  if (steps.length <= visibleCount) return steps
  const end = steps.length - scrollOffset
  const start = Math.max(0, end - visibleCount)
  return steps.slice(start, end)
}

// ---------------------------------------------------------------------------
// <BannerBox> — single-line banner above the steps grid.
// ---------------------------------------------------------------------------

function BannerBox({ banner }: { readonly banner: Banner }): React.ReactElement {
  if (banner.kind === 'error') {
    return (
      <Box>
        <Text color="red">{`! ${truncate(banner.text, 200)} · Esc dismiss`}</Text>
      </Box>
    )
  }
  return (
    <Box>
      <Text color="cyan" dimColor>
        {truncate(banner.text, 200)}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// <StepRow> — single-step line, memo'd with threshold-bucketed props.
// ---------------------------------------------------------------------------

interface StepRowProps {
  readonly step: StepRowData
  readonly columns: ColumnSet
  readonly now: number
  readonly selected: boolean
}

const StepRow = memo(
  function StepRowImpl({ step, columns, now, selected }: StepRowProps): React.ReactElement {
    const cursor = selected ? '▌' : ' '
    const view = stepGlyphView(step.status)
    const name = stripAnsi(step.name)
    const elapsed = formatElapsedFor(step, now)
    const showElapsed = columns.elapsed && elapsed.length > 0
    // Multi-segment <Text>: produces the same byte sequence as the previous
    // `parts.join('  ')` output (cursor · space · name · two-space · glyph
    // [· two-space · elapsed]), with style spans around cursor, name, and
    // glyph. Selection cyan applies only to cursor + name; glyph keeps its
    // semantic color from `stepGlyphView`.
    const accent = selected ? 'cyan' : undefined
    return (
      <Text>
        <Text color={accent}>{cursor}</Text>
        <Text> </Text>
        <Text bold={selected} color={accent}>
          {name}
        </Text>
        <Text>{'  '}</Text>
        <Text color={view.color} dimColor={view.dim}>
          {view.char}
        </Text>
        {showElapsed ? <Text>{`  ${elapsed}`}</Text> : null}
      </Text>
    )
  },
  (prev, next) => {
    if (prev.selected !== next.selected) return false
    if (prev.columns.elapsed !== next.columns.elapsed) return false
    if (prev.step.name !== next.step.name) return false
    if (prev.step.status !== next.step.status) return false
    if (prev.step.kind !== next.step.kind) return false
    if (prev.step.startedAt !== next.step.startedAt) return false
    if (prev.step.endedAt !== next.step.endedAt) return false
    // Bucket elapsed to 1s so a tick that doesn't cross a second boundary
    // doesn't re-render the row.
    return bucketSeconds(prev.now, prev.step) === bucketSeconds(next.now, next.step)
  },
)

function bucketSeconds(now: number, step: StepRowData): number {
  if (step.startedAt === undefined) return 0
  const end = step.endedAt ?? now
  return Math.round((end - step.startedAt) / 1000)
}

function formatElapsedFor(step: StepRowData, now: number): string {
  if (step.startedAt === undefined) return ''
  const end = step.endedAt ?? now
  return formatElapsed(end - step.startedAt)
}

// ---------------------------------------------------------------------------
// <ParallelGroup> — placeholder. Phase 1 doesn't surface parallel branches;
// future phases project parallel-branch-update events into this component.
// ---------------------------------------------------------------------------

export interface ParallelGroupProps {
  readonly parentName: string
  readonly children: readonly StepRowData[]
}

export function ParallelGroup({ parentName, children }: ParallelGroupProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{`▸ ${parentName}`}</Text>
      {children.map((c) => (
        <Text key={c.name}>{`  ├─ ${c.name}`}</Text>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// <HelpOverlay> + <ViewModeFooter>
// ---------------------------------------------------------------------------

export function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
      <Text bold>Keymap</Text>
      <Text>↑/↓ move selection</Text>
      <Text>j/k scroll one row · PgUp/PgDn scroll a page</Text>
      <Text>Home (or g) jump to top · End (or G) jump to live tail</Text>
      <Text>⏎ view selected step</Text>
      <Text>f follow live (or rollup) — returns to the most recent live source</Text>
      <Text>Esc close this help · dismiss error banner</Text>
      <Text>? toggle this help</Text>
      <Text>q quit (run continues)</Text>
      <Text> </Text>
      <Text dimColor>
        Footer indicator: ▶ live · ⏸ viewing &lt;step&gt; · ↑ scrolled · End live
      </Text>
      <Text dimColor>Banner: info auto-clears (~4s) · error persists until Esc or next emit</Text>
    </Box>
  )
}

function ViewModeFooter({
  view,
  scrollOffset,
}: {
  readonly view: ViewMode
  readonly scrollOffset: number
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>{renderViewModeFooter(view, scrollOffset)}</Text>
    </Box>
  )
}

function renderViewModeFooter(view: ViewMode, scrollOffset: number): string {
  // `f` is hidden in live mode — it's a no-op when already on the most-recent
  // live source. Re-introduced when the parallel-switcher UX ships and `f`
  // carries cycle-between-branches semantics.
  const base =
    view.mode === 'live'
      ? '▶ live · ⏎ view step · q quit · ? help'
      : `⏸ viewing ${truncate(view.stepName, STEP_NAME_MAX)} · f live · ⏎ view another · q quit · ? help`
  return scrollOffset > 0 ? `${base} · ↑ scrolled · End live` : base
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function renderHeader(state: StepsViewState): string {
  const title = stripAnsi(state.run.workflowName)
  return `orch · ${title} · ${state.run.runId}`
}

interface KeyInfo {
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly return?: boolean
  readonly escape?: boolean
  readonly ctrl?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
  readonly home?: boolean
  readonly end?: boolean
}

function classifyKey(input: string, key: KeyInfo): StepsViewKeyEvent['key'] {
  if (key.pageUp === true) return 'pageUp'
  if (key.pageDown === true) return 'pageDown'
  if (key.home === true || input === 'g') return 'home'
  if (key.end === true || input === 'G') return 'end'
  if (key.upArrow === true) return 'up'
  if (key.downArrow === true) return 'down'
  if (key.return === true) return 'return'
  if (key.escape === true) return 'esc'
  if (key.ctrl === true && (input === 'c' || input === 'C')) return 'ctrl-c'
  if (input === 'j') return 'j'
  if (input === 'k') return 'k'
  if (input === 'f') return 'f'
  if (input === 'q') return 'q'
  if (input === '?') return '?'
  return 'other'
}

// Hook implementations live in `steps-view-hooks.ts`. Re-exported above for
// callers that import from `index.ts`.
