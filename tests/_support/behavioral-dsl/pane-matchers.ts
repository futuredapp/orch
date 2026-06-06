/**
 * Pane-content matchers. Each constructor returns a `PaneMatcherFactory` —
 * a function that, given the bound pane (`'left'` or `'right'` from the
 * assertion), returns a `Matcher` projecting over the snapshot's pane
 * fields.
 */

import type { LifecycleSnapshot, Matcher, PaneMatcherFactory } from './internal/snapshot.ts'

export type PaneInkState = 'live' | 'viewing' | 'end-of-run' | 'error-banner'

function paneTextOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): string {
  return pane === 'left' ? snapshot.leftPaneText : snapshot.rightPaneText
}

function paneFocusedOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): boolean {
  return pane === 'left' ? snapshot.leftPaneFocused : snapshot.rightPaneFocused
}

function paneDeadOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): boolean | undefined {
  // The snapshot's `panesAlive` is ordered by `tmux list-panes`. We don't
  // know the pane id of "left" / "right" without consulting the probe — the
  // snapshot already pre-resolved leftPaneText / rightPaneText, so we use
  // the panesAlive table positionally as a fallback: index 0 = left, last =
  // right (matches the probe's pane resolution order in
  // `external-tmux-probe.ts`).
  if (snapshot.panesAlive.length === 0) return undefined
  const target = pane === 'left' ? snapshot.panesAlive[0] : snapshot.panesAlive.at(-1)
  return target?.dead
}

const STATE_PATTERNS: Readonly<Record<PaneInkState, RegExp>> = {
  // The Ink steps view renders a live banner using the unicode "▶" + the
  // word "live" (see `src/hosts/two-pane/steps-view/steps-view.tsx`). We
  // tolerate width / coloring variations by matching the icon-and-keyword
  // substring; the strict copy lives in the implementation.
  live: /▶\s*live/i,
  viewing: /viewing/i,
  'end-of-run': /end of run|finished/i,
  'error-banner': /✗|error|failed/i,
}

export const containsText = (needle: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (ok) {
      return {
        matched: true,
        message: `containsText(${formatNeedle(needle)}): matched on ${pane} pane`,
      }
    }
    return {
      matched: false,
      message: `containsText(${formatNeedle(needle)}): not present in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const doesNotContain = (needle: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const present = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (!present) {
      return {
        matched: true,
        message: `doesNotContain(${formatNeedle(needle)}): absent from ${pane} pane`,
      }
    }
    return {
      matched: false,
      message: `doesNotContain(${formatNeedle(needle)}): unexpectedly present in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const isFocused = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const focused = paneFocusedOf(snapshot, pane)
    if (focused) {
      return { matched: true, message: `isFocused: ${pane} pane is focused` }
    }
    return {
      matched: false,
      message: `isFocused: ${pane} pane is NOT focused (leftFocused=${snapshot.leftPaneFocused}, rightFocused=${snapshot.rightPaneFocused})`,
    }
  }
}

export const showsInkState = (state: PaneInkState): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const pattern = STATE_PATTERNS[state]
    const text = paneTextOf(snapshot, pane)
    if (pattern.test(text)) {
      return { matched: true, message: `showsInkState("${state}"): matched on ${pane} pane` }
    }
    return {
      matched: false,
      message: `showsInkState("${state}"): not matched on ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const hasFooterText = (text: string | RegExp): PaneMatcherFactory => {
  // Footer is the last few lines of the pane text — projector splits and
  // matches against the tail. The exact line count matches what the steps
  // view renders below the live region.
  const FOOTER_LINES = 4
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const body = paneTextOf(snapshot, pane)
    const lines = body.split('\n')
    const footer = lines.slice(-FOOTER_LINES).join('\n')
    const ok = typeof text === 'string' ? footer.includes(text) : text.test(footer)
    if (ok) {
      return {
        matched: true,
        message: `hasFooterText(${formatNeedle(text)}): matched on ${pane} pane footer`,
      }
    }
    return {
      matched: false,
      message: `hasFooterText(${formatNeedle(text)}): not in ${pane} pane footer (footer=${truncate(footer)})`,
    }
  }
}

export const hasNoLiveOutput = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane).trim()
    if (text.length === 0) {
      return { matched: true, message: `hasNoLiveOutput: ${pane} pane is empty` }
    }
    return {
      matched: false,
      message: `hasNoLiveOutput: ${pane} pane has content (text=${truncate(text)})`,
    }
  }
}

export const isPaneDead = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const dead = paneDeadOf(snapshot, pane)
    if (dead === true) {
      return { matched: true, message: `isPaneDead: ${pane} pane has pane_dead=1` }
    }
    return {
      matched: false,
      message: `isPaneDead: ${pane} pane dead=${dead === undefined ? 'unknown' : 'false'}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Behavioral matchers — observable structure of the left pane (step rows,
// glyphs, badges, header, footer). All read against the ANSI-stripped pane
// text in the snapshot. Glyph chars match `src/observability/status-pane.ts`'s
// INK_STEP_VIEW table; if those change, both sides need updating.
// ---------------------------------------------------------------------------

const STEP_GLYPH_CHARS: Readonly<Record<StepRowGlyph, string>> = {
  running: '◐',
  completed: '✓',
  failed: '✗',
  cached: '↺',
  pending: '·',
  interactive: '⟳',
}

export type StepRowGlyph = 'pending' | 'running' | 'interactive' | 'completed' | 'failed' | 'cached'

/**
 * Locates the row line containing the step name. Step name is rendered with
 * some leading whitespace + glyph + name; we use `\b<name>\b`-ish matching
 * against each line.
 */
function findStepLine(paneText: string, stepName: string): string | undefined {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`)
  for (const line of paneText.split('\n')) {
    if (re.test(line)) return line
  }
  return undefined
}

export const showsWorkflowHeader = (workflowName: string): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    if (text.includes(workflowName)) {
      return {
        matched: true,
        message: `showsWorkflowHeader("${workflowName}"): matched on ${pane} pane`,
      }
    }
    return {
      matched: false,
      message: `showsWorkflowHeader("${workflowName}"): not present in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const showsStep = (stepName: string, status?: StepRowGlyph): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const line = findStepLine(text, stepName)
    if (line === undefined) {
      return {
        matched: false,
        message: `showsStep("${stepName}"): no row found in ${pane} pane (text=${truncate(text)})`,
      }
    }
    if (status === undefined) {
      return { matched: true, message: `showsStep("${stepName}"): row present` }
    }
    const glyph = STEP_GLYPH_CHARS[status]
    if (line.includes(glyph)) {
      return {
        matched: true,
        message: `showsStep("${stepName}", "${status}"): row + glyph "${glyph}" present`,
      }
    }
    return {
      matched: false,
      message: `showsStep("${stepName}", "${status}"): row line=${JSON.stringify(line)} lacks glyph "${glyph}"`,
    }
  }
}

export const stepHasGlyph = (stepName: string, status: StepRowGlyph): PaneMatcherFactory => {
  // Alias of `showsStep(name, status)` kept for cells that want the verb to
  // emphasise the glyph rather than the row's presence.
  return showsStep(stepName, status)
}

export const stepIsHighlighted = (stepName: string): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const line = findStepLine(text, stepName)
    if (line === undefined) {
      return {
        matched: false,
        message: `stepIsHighlighted("${stepName}"): no row found in ${pane} pane`,
      }
    }
    // The Ink steps view renders selection as a `▌` cursor on the row, but
    // ONLY when the user has driven selection manually (isUserDriven=true).
    // On initial load the cursor is hidden — selection invisibly follows the
    // live step. See `src/hosts/two-pane/steps-view/steps-view.tsx:248`.
    const HIGHLIGHT_MARKERS = ['▌']
    if (HIGHLIGHT_MARKERS.some((m) => line.includes(m))) {
      return {
        matched: true,
        message: `stepIsHighlighted("${stepName}"): selection marker on row`,
      }
    }
    return {
      matched: false,
      message: `stepIsHighlighted("${stepName}"): no selection marker on row line=${JSON.stringify(line)}`,
    }
  }
}

export const showsInteractiveBadge = (stepName: string): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const line = findStepLine(text, stepName)
    if (line === undefined) {
      return {
        matched: false,
        message: `showsInteractiveBadge("${stepName}"): no row found in ${pane} pane`,
      }
    }
    // Two visible markers for interactive mode in the current Ink view:
    //   - the `⟳` glyph (INK_STEP_VIEW.interactive) used while the step is mid-run
    //   - a `·i·` badge segment in the step name column
    if (line.includes('⟳') || /·\s*i\s*·/.test(line) || line.includes('[i]')) {
      return {
        matched: true,
        message: `showsInteractiveBadge("${stepName}"): badge present`,
      }
    }
    return {
      matched: false,
      message: `showsInteractiveBadge("${stepName}"): no badge on row line=${JSON.stringify(line)}`,
    }
  }
}

export const showsRunCount = (completed: number, total: number): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    // End-of-run summary line: "steps N/M completed"
    const needle = `steps ${completed}/${total} completed`
    if (text.includes(needle)) {
      return { matched: true, message: `showsRunCount(${completed}/${total}): matched` }
    }
    return {
      matched: false,
      message: `showsRunCount(${completed}/${total}): "${needle}" not in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const showsEndOfRunSummary = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    if (/run completed|run failed|run crashed/i.test(text)) {
      return { matched: true, message: 'showsEndOfRunSummary: matched' }
    }
    return {
      matched: false,
      message: `showsEndOfRunSummary: no end-of-run line in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const showsInfoBanner = (needle?: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    // The Ink info banner uses a leading icon (e.g. `ℹ` or `▸`). Detection
    // is heuristic — assert on the supplied needle, plus the absence of
    // typical error markers, so info-vs-error remains distinguishable.
    if (needle === undefined) {
      // Empty needle = "is there an info-style banner at all?" — we use a
      // narrow heuristic: pane contains a banner-like prefix and NO error
      // glyph. Cells should usually pass a needle.
      if (/[ℹ▸].+/.test(text) && !/✗|error/i.test(text)) {
        return { matched: true, message: 'showsInfoBanner: info-style banner detected' }
      }
      return {
        matched: false,
        message: `showsInfoBanner: no info banner detected (text=${truncate(text)})`,
      }
    }
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (ok) {
      return {
        matched: true,
        message: `showsInfoBanner(${formatNeedle(needle)}): matched`,
      }
    }
    return {
      matched: false,
      message: `showsInfoBanner(${formatNeedle(needle)}): not in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const showsErrorBanner = (needle?: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const hasErrorGlyph = /✗|error|failed/i.test(text)
    if (!hasErrorGlyph) {
      return {
        matched: false,
        message: `showsErrorBanner: no error marker in ${pane} pane (text=${truncate(text)})`,
      }
    }
    if (needle === undefined) {
      return { matched: true, message: 'showsErrorBanner: error marker detected' }
    }
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (ok) {
      return {
        matched: true,
        message: `showsErrorBanner(${formatNeedle(needle)}): matched`,
      }
    }
    return {
      matched: false,
      message: `showsErrorBanner(${formatNeedle(needle)}): glyph present but text=${truncate(text)} lacks needle`,
    }
  }
}

export const showsHelpOverlay = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    // The help overlay renders keymap entries (e.g. "↑/↓ select", "q quit").
    // Match on at least two of these to avoid false positives from the
    // permanent footer (which has overlapping copy).
    const hints = ['select', 'quit', 'help', 'view', 'live']
    const matches = hints.filter((h) => text.includes(h)).length
    if (matches >= 3) {
      return {
        matched: true,
        message: `showsHelpOverlay: ${matches}/${hints.length} hints visible`,
      }
    }
    return {
      matched: false,
      message: `showsHelpOverlay: only ${matches}/${hints.length} hints visible (text=${truncate(text)})`,
    }
  }
}

export const showsFailureSummary = (needle?: string | RegExp): PaneMatcherFactory => {
  // The right pane renders a failure block when a step fails. We accept any
  // mention of "failed" plus the optional error needle.
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    if (!/failed|error/i.test(text)) {
      return {
        matched: false,
        message: `showsFailureSummary: no failure marker in ${pane} pane (text=${truncate(text)})`,
      }
    }
    if (needle === undefined) {
      return { matched: true, message: 'showsFailureSummary: failure block detected' }
    }
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (ok) {
      return { matched: true, message: `showsFailureSummary(${formatNeedle(needle)}): matched` }
    }
    return {
      matched: false,
      message: `showsFailureSummary(${formatNeedle(needle)}): marker present but text=${truncate(text)} lacks needle`,
    }
  }
}

function formatNeedle(n: string | RegExp): string {
  return n instanceof RegExp ? n.toString() : JSON.stringify(n)
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return JSON.stringify(s)
  return `${JSON.stringify(s.slice(0, max))}… (+${s.length - max} bytes)`
}

// Re-export the Matcher type so consumers of the barrel can import the unified
// type even though pane matchers are PaneMatcherFactory at construction time.
export type { Matcher }
