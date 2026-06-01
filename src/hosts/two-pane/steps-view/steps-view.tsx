// ---------------------------------------------------------------------------
// <StepsView> — Ink components for the two-pane left pane.
// ---------------------------------------------------------------------------
//
// Renders a `StepsViewState` plus user-driven selection. Hooks:
//   - `useAdaptiveColumns(stdout)` — width → ColumnSet (debounced re-render)
//   - `useStepsSelection(steps, view)` — the COMMITTED highlight (`▌`+bold+cyan)
//     tracks `state.view` so the left pane always points at what the right pane
//     shows (Issue 2); `↑/↓` drive a separate PREVIEW cursor (`›`) committed on
//     `⏎`.
//
// Keymap: `↑/↓` move the preview cursor · `⏎` commit it · `f` snap-to-live ·
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
import { computeVisibleCount, estimateWrappedRows } from './steps-view-layout.ts'

export type { StepsScroll, StepsSelection } from './steps-view-hooks.ts'
export { useAdaptiveColumns, useStepsScroll, useStepsSelection } from './steps-view-hooks.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INFO_TTL_MS = 4000

// Stable module-scope default so the auto-dismiss `useEffect` does not re-arm
// the timer on every render (the effect lists `scheduleDismiss` in its deps).
const defaultScheduleDismiss = (callback: () => void, ms: number): (() => void) => {
  const handle = setTimeout(callback, ms)
  return () => {
    clearTimeout(handle)
  }
}
const STEP_NAME_MAX = 30

// U9: gutter-aware truncation budget for step rows. `effectiveDepth` is the
// row's effective depth after R23 parallel-suppression collapse (a step inside
// a parallel branch already carries `depth: 0` from the projector, so we just
// read `step.depth`). Each `│ ` is 2 chars; floored at 12 so very deep nesting
// doesn't squash the name column to nothing.
function stepNameBudget(depth: number): number {
  return Math.max(12, STEP_NAME_MAX - 2 * depth)
}

// U9: same budget logic for boundary rows. A depth-d boundary aligns at the
// depth-(d-1) gutter, then `▼ ` / `✓ ` / `✗ ` adds 2 chars before the name —
// total cost works out to `2 * d`, identical to the step-row budget at depth
// d. Pulled out for readability.
function boundaryNameBudget(depth: number): number {
  return Math.max(12, STEP_NAME_MAX - 2 * depth)
}

// Stacked gutter token, one `│ ` per depth column. The narrow-pane collapse
// path (U9) substitutes a single `│N ` token; see `gutterFor`.
function stackedGutter(depth: number): string {
  if (depth <= 0) return ''
  return '│ '.repeat(depth)
}

// Step rows persist their FULL cache key (e.g. `simple-feature>plan`); the
// visible label strips the sub prefix so the rendered name is just `plan`.
// Used by both step rows and the renderer-side display layer.
function displayName(name: string): string {
  const idx = name.lastIndexOf('>')
  return idx === -1 ? name : name.slice(idx + 1)
}

// Boundary rows and step rows can share a stable `name` (a sub `simple` and
// some step `simple` are distinct in R20 but indistinguishable by name alone),
// so React keys mix kind + depth + name.
function rowKey(step: StepRowData): string {
  if (step.kind === 'subworkflow-enter') return `enter:${step.depth}:${step.name}`
  if (step.kind === 'subworkflow-exit') return `exit:${step.depth}:${step.name}`
  return step.name
}

function isSelectableRow(step: StepRowData): boolean {
  return step.kind !== 'subworkflow-enter' && step.kind !== 'subworkflow-exit'
}

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
  scheduleDismiss = defaultScheduleDismiss,
  onKey,
}: StepsViewProps): React.ReactElement {
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
        // R24 defensive guard: selection-skip should already prevent the
        // preview cursor from landing on a boundary row, but a fixture or
        // scroll-window cut could still expose one. Enter on a boundary is a
        // no-op — no intent, no info banner (the brainstorm's AE10 "optionally"
        // wording was dropped so two implementers cannot diverge).
        const target = state.steps.find((s) => s.name === selectedName)
        if (target !== undefined && isSelectableRow(target)) {
          onIntent({ type: 'enter', stepName: selectedName })
        }
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
                preview={isUserDriven && step.name === selectedName && step.name !== committedName}
                paneCols={paneCols}
              />
            ),
          )}
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
        <Text color="red">{bannerText(banner)}</Text>
      </Box>
    )
  }
  return (
    <Box>
      <Text color="cyan" dimColor>
        {bannerText(banner)}
      </Text>
    </Box>
  )
}

/** The rendered banner string — also used to measure its wrapped height. */
function bannerText(banner: Banner): string {
  return banner.kind === 'error'
    ? `! ${truncate(banner.text, 200)} · Esc dismiss`
    : truncate(banner.text, 200)
}

// ---------------------------------------------------------------------------
// <StepRow> — single-step line, memo'd with threshold-bucketed props.
// ---------------------------------------------------------------------------

type SelectableRow = Exclude<StepRowData, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>

interface StepRowProps {
  readonly step: SelectableRow
  readonly columns: ColumnSet
  readonly now: number
  /** Committed selection — the row the right pane shows. Drawn `▌` + bold + cyan. */
  readonly selected: boolean
  /** `↑/↓` preview cursor (only when it differs from `selected`). Drawn bold `›`. */
  readonly preview: boolean
  /** Current pane column count — drives U9's depth-overflow collapse rule. */
  readonly paneCols: number
}

const StepRow = memo(
  function StepRowImpl({
    step,
    columns,
    now,
    selected,
    preview,
    paneCols,
  }: StepRowProps): React.ReactElement {
    // `▌` marks the committed row (= right pane); `›` is the preview cursor the
    // user is browsing with `↑/↓` before committing with `Enter`. They never
    // coincide — the call site suppresses `preview` on the committed row.
    const cursor = selected ? '▌' : preview ? '›' : ' '
    const view = stepGlyphView(step.status)
    const depth = rowDepth(step)
    const gutter = gutterFor(depth, paneCols)
    const name = truncate(displayName(stripAnsi(step.name)), stepNameBudget(depth))
    const elapsed = formatElapsedFor(step, now)
    const showElapsed = columns.elapsed && elapsed.length > 0
    const accent = selected ? 'cyan' : undefined
    const emphasised = selected || preview
    return (
      <Text>
        <Text bold={preview} color={accent}>
          {cursor}
        </Text>
        <Text> </Text>
        {gutter.length > 0 ? <Text dimColor>{gutter}</Text> : null}
        <Text bold={emphasised} color={accent}>
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
    if (prev.preview !== next.preview) return false
    if (prev.columns.elapsed !== next.columns.elapsed) return false
    if (prev.paneCols !== next.paneCols) return false
    if (prev.step.name !== next.step.name) return false
    if (prev.step.status !== next.step.status) return false
    if (prev.step.kind !== next.step.kind) return false
    if (prev.step.startedAt !== next.step.startedAt) return false
    if (prev.step.endedAt !== next.step.endedAt) return false
    if (rowDepth(prev.step) !== rowDepth(next.step)) return false
    // Bucket elapsed to 1s so a tick that doesn't cross a second boundary
    // doesn't re-render the row.
    return bucketSeconds(prev.now, prev.step) === bucketSeconds(next.now, next.step)
  },
)

// ---------------------------------------------------------------------------
// <SubBoundaryRow> — the `▼ <name>` enter / `✓ <name>` / `✗ <name>` exit row.
// ---------------------------------------------------------------------------
//
// Lives only in the projected state — never persisted, never selectable, never
// the right-pane focus. Renders the gutter at depth-(d-1) so the row aligns
// visually one column to the left of its child steps, matching the brainstorm's
// `▼ outer / │ child / ✓ outer` nesting illustration.

interface SubBoundaryRowProps {
  readonly row: Extract<StepRowData, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>
  readonly paneCols: number
}

function SubBoundaryRow({ row, paneCols }: SubBoundaryRowProps): React.ReactElement {
  const gutterDepth = Math.max(0, row.depth - 1)
  const gutter = gutterForRow(row.depth, gutterDepth, paneCols)
  const name = truncate(displayName(stripAnsi(row.name)), boundaryNameBudget(row.depth))
  // Failure color: `✗` glyph is the primary signal. Red is additive — NO_COLOR
  // / color-blind terminals fall back to the glyph alone.
  const isFailure = row.kind === 'subworkflow-exit' && row.glyph === '✗'
  const trailing =
    row.kind === 'subworkflow-exit' && row.durationMs !== undefined
      ? formatElapsed(row.durationMs)
      : '…'
  return (
    <Text>
      <Text> </Text>
      <Text> </Text>
      {gutter.length > 0 ? <Text dimColor>{gutter}</Text> : null}
      <Text color={isFailure ? 'red' : undefined}>{row.glyph}</Text>
      <Text> </Text>
      <Text dimColor>{name}</Text>
      <Text>{'  '}</Text>
      <Text dimColor>{trailing}</Text>
    </Text>
  )
}

// Effective depth for memo equality + gutter selection. Reads through the
// optional `depth` field on every variant; absent ⇔ 0 (root).
function rowDepth(step: StepRowData): number {
  if (step.kind === 'subworkflow-enter' || step.kind === 'subworkflow-exit') return step.depth
  return step.depth ?? 0
}

// U9 collapse: when the row's LOGICAL depth >= 4 AND paneCols < 60, render the
// compact `│N ` token (e.g. `│4 ` for a depth-4 step, `│3 ` for the matching
// boundary row of a depth-4 sub). The boundary-row case passes `triggerDepth`
// = sub's depth and `renderDepth` = sub's depth - 1 so the boundary aligns at
// one gutter column less than its children — matching the brainstorm rule that
// `▼`/`✓` rows render with (d-1) gutter columns. Step rows pass them equal.
function gutterFor(depth: number, paneCols: number): string {
  return gutterForRow(depth, depth, paneCols)
}

function gutterForRow(triggerDepth: number, renderDepth: number, paneCols: number): string {
  if (renderDepth <= 0) return ''
  if (triggerDepth >= 4 && paneCols < 60) return `│${renderDepth} `
  return stackedGutter(renderDepth)
}

function bucketSeconds(now: number, step: SelectableRow): number {
  if (step.startedAt === undefined) return 0
  const end = step.endedAt ?? now
  return Math.round((end - step.startedAt) / 1000)
}

function formatElapsedFor(step: SelectableRow, now: number): string {
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
      {/* Single line: a wrapping footer changes height as its text grows,
          which tips the frame across Ink's fullscreen boundary and triggers a
          full-clear flicker (see steps-view-layout.ts). `truncate-end` keeps
          the line at one row regardless of width. */}
      <Text dimColor wrap="truncate-end">
        {renderViewModeFooter(view, scrollOffset)}
      </Text>
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
  // Lead with the scroll indicator when scrolled so it survives single-line
  // truncation at narrow widths — losing "End live" would strand the user
  // away from the live tail with no visible way back.
  return scrollOffset > 0 ? `↑ scrolled · End live · ${base}` : base
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function renderHeader(state: StepsViewState): string {
  const title = stripAnsi(state.run.workflowName)
  return `orch · ${title} · ${state.run.runId}`
}

/**
 * Wrapped row count of the header block at `columns`. The live header is one
 * (wrapping) line; the terminal-state header is the two-line
 * `<EndOfRunSummary>` block (breadcrumb + status, then the totals line).
 */
function estimateHeaderRows(state: StepsViewState, columns: number): number {
  if (state.status === 'live') {
    return estimateWrappedRows(renderHeader(state), columns)
  }
  const summary = state.summary
  const breadcrumb = `orch · ${stripAnsi(state.run.workflowName)} · ${state.run.runId} · ${state.status}`
  const totals =
    summary !== undefined
      ? `steps ${summary.stepsCompleted}/${summary.stepsTotal} completed · duration`
      : ''
  return estimateWrappedRows(breadcrumb, columns) + estimateWrappedRows(totals, columns)
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

// Plain single-character keys map straight through; pulled out of classifyKey
// to keep its cognitive-complexity under the rule-5 budget. The special-key
// (key.*) checks below still run first and take precedence.
const CHAR_KEYS: Record<string, StepsViewKeyEvent['key']> = {
  j: 'j',
  k: 'k',
  f: 'f',
  q: 'q',
  '?': '?',
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
  return CHAR_KEYS[input] ?? 'other'
}

// Hook implementations live in `steps-view-hooks.ts`. Re-exported above for
// callers that import from `index.ts`.
