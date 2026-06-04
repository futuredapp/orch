/**
 * steps.ts — DEV-ONLY. Parse a left-pane (steps-view) capture into a structured
 * list so the QA agent gets a reliable read of "which steps exist, what state
 * each is in, which is active, did a subworkflow launch" instead of eyeballing
 * ASCII. Best-effort by design: the glyph vocabulary is the load-bearing
 * contract (mirrors `src/observability/status-pane.ts#stepGlyphView` and the
 * subworkflow boundary rows in `steps-view/step-types.ts`); the agent can always
 * fall back to the raw capture for nuance the parser drops.
 */

/** Logical state inferred from a row's leading glyph. */
export type ParsedStepStatus =
  | 'pending'
  | 'running'
  | 'interactive'
  | 'completed'
  | 'failed'
  | 'cached'
  | 'subworkflow-enter'

/** Glyph → status. `✓`/`✗` double as subworkflow-exit; reported generically. */
const GLYPH_STATUS: ReadonlyMap<string, ParsedStepStatus> = new Map([
  ['·', 'pending'],
  ['◐', 'running'],
  ['⟳', 'interactive'],
  ['✓', 'completed'],
  ['✗', 'failed'],
  ['↺', 'cached'],
  ['▼', 'subworkflow-enter'],
])

/** Selection-gutter width the steps-view reserves (`▌ ` or two spaces). */
const GUTTER = /^(▌ | {2})/

/** Box-drawing prefix the view uses to nest subworkflow steps (`│ `, `├─ `…). */
const TREE_PREFIX = /^([│├└─╰╭┌\s]+)/

function isGlyph(token: string): boolean {
  return token.length === 1 && GLYPH_STATUS.has(token)
}

/** Consume a leading tree-branch prefix; depth = number of branch markers. */
function stripTree(body: string): { readonly depth: number; readonly rest: string } {
  const match = TREE_PREFIX.exec(body)
  if (match?.[1] === undefined) return { depth: 0, rest: body }
  const prefix = match[1]
  const depth = (prefix.match(/[│├└]/g) ?? []).length
  return { depth, rest: body.slice(prefix.length) }
}

export interface ParsedStep {
  readonly name: string
  readonly status: ParsedStepStatus
  readonly glyph: string
  /** Indentation depth in gutter columns (0 = root, >0 = inside a subworkflow). */
  readonly depth: number
  /** True for `running`/`interactive` rows — the step currently driving the run. */
  readonly active: boolean
}

export interface ParsedStepsView {
  readonly steps: readonly ParsedStep[]
  /** The single active step, if any (first `running`/`interactive` row). */
  readonly activeStep?: ParsedStep
  /** True iff at least one subworkflow-enter (`▼`) row is present. */
  readonly hasSubworkflow: boolean
}

/** True for header / separator / footer chrome — never a step row. */
function isChrome(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  if (/^orch\s/.test(trimmed)) return true // header: `orch · <wf> · <runId>`
  if (/^[─-]+$/.test(trimmed)) return true // separator rule
  if (/(live ·|view step|quit|help)/.test(trimmed)) return true // footer keymap
  return false
}

/**
 * Parse one captured line into a step, or `undefined` if it is not a step row.
 *
 * Row shape (see the empirical capture, not the aspirational docs):
 *   `[▌| ] <name>  <status-glyph>  [elapsed] [cost] …`
 * The status glyph sits in its OWN column (2-space separated), at the end for
 * step rows or first for subworkflow boundary rows. The 2-space column gap is
 * what distinguishes a status `·` (pending) from middots in the chrome.
 */
function parseRow(line: string): ParsedStep | undefined {
  if (isChrome(line)) return undefined

  const selected = /^\s*▌/.test(line)
  const { depth, rest } = stripTree(line.replace(GUTTER, ''))

  // Subworkflow boundary rows render glyph-first with a SINGLE space (`▼ sub`);
  // ordinary step rows render the glyph in its own 2-space-separated column at
  // the end (`name  ✓`).
  let glyph: string | undefined
  let name: string | undefined
  const head = rest.charAt(0)
  if (isGlyph(head) && rest.charAt(1) === ' ') {
    glyph = head
    name = rest.slice(1).split(/\s{2,}/)[0]?.trim()
  } else {
    const parts = rest
      .split(/\s{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    name = parts[0]
    glyph = parts.slice(1).find(isGlyph)
  }

  if (glyph === undefined || name === undefined || name.length === 0) return undefined
  const status = GLYPH_STATUS.get(glyph)
  if (status === undefined) return undefined

  return {
    name,
    status,
    glyph,
    depth,
    active: status === 'running' || status === 'interactive' || (selected && status === 'pending'),
  }
}

/** Parse a full left-pane capture into a structured steps view. */
export function parseStepsView(capture: string): ParsedStepsView {
  const steps: ParsedStep[] = []
  for (const line of capture.split('\n')) {
    const step = parseRow(line)
    if (step !== undefined) steps.push(step)
  }
  return {
    steps,
    activeStep: steps.find((s) => s.active),
    hasSubworkflow: steps.some((s) => s.status === 'subworkflow-enter'),
  }
}
