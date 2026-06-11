// ---------------------------------------------------------------------------
// steps-view-keymap — PURE key → action resolution for the left pane.
// ---------------------------------------------------------------------------
//
// `<StepsView>`'s `useInput` handler delegates here so the entire keymap —
// including its precedence rules (help-overlay swallow > Esc banner dismiss >
// scroll > selection > commit > follow-live > Ctrl-C > failure actions >
// quit > help) — is a single testable function with no Ink dependency.
//
// Precedence notes preserved from the original inline handler:
//   - While help is open, only Esc / `?` do anything (close it).
//   - Esc outside help dismisses an ERROR banner only; info banners
//     auto-clear and are not manually dismissable (single-slot semantics).
//   - Scroll keys resolve before selection keys so j/k/PgUp/PgDn/Home/End
//     cannot be shadowed by arrow-key selection movement on terminals that
//     report the arrow keys with the same legacy escape sequence.
//   - Ctrl-C resolves before the failure-action `c` so it always quits.
//   - `r`/`c` stay inert unless the interactive failed re-entry view enabled
//     failure actions (U6).

/** Subset of Ink's `Key` that the steps-view keymap reads. */
export interface KeyInfo {
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

export type StepsKeyTag =
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

export interface StepsKeymapContext {
  /** A dialog owns the keyboard — the keymap swallows everything. */
  readonly dialogOpen: boolean
  readonly hasErrorBanner: boolean
  /** U6: interactive failed re-entry view — enables the `r`/`c`/`a` actions. */
  readonly failureActions: boolean
  /** Live run — `q` asks to confirm; terminal states quit immediately. */
  readonly isLive: boolean
}

export type StepsKeyAction =
  | {
      readonly type: 'open-dialog'
      readonly dialog: 'help' | 'confirm-quit' | 'failure-actions'
    }
  | { readonly type: 'dismiss-banner' }
  | {
      readonly type: 'scroll'
      readonly to: 'up' | 'down' | 'page-up' | 'page-down' | 'top' | 'bottom'
    }
  | { readonly type: 'move-selection'; readonly dir: 'up' | 'down' }
  | { readonly type: 'commit-selection' }
  | { readonly type: 'follow-live' }
  | { readonly type: 'retry' }
  | { readonly type: 'retry-continue' }
  | { readonly type: 'quit' }
  | { readonly type: 'none' }

const NONE: StepsKeyAction = { type: 'none' }

export function resolveStepsKeyAction(
  input: string,
  key: KeyInfo,
  ctx: StepsKeymapContext,
): StepsKeyAction {
  if (ctx.dialogOpen) {
    // The open dialog's own `useInput` handles every key (navigation,
    // activation, close) — the steps keymap stays entirely out of the way.
    return NONE
  }
  if (key.escape === true) {
    return ctx.hasErrorBanner ? { type: 'dismiss-banner' } : NONE
  }
  const scroll = resolveScroll(input, key)
  if (scroll !== undefined) return scroll
  if (key.upArrow === true) return { type: 'move-selection', dir: 'up' }
  if (key.downArrow === true) return { type: 'move-selection', dir: 'down' }
  if (key.return === true) return { type: 'commit-selection' }
  if (input === 'f' || input === 'F') return { type: 'follow-live' }
  if (key.ctrl === true && (input === 'c' || input === 'C')) return { type: 'quit' }
  if (ctx.failureActions && (input === 'r' || input === 'R')) return { type: 'retry' }
  if (ctx.failureActions && (input === 'c' || input === 'C')) return { type: 'retry-continue' }
  if (ctx.failureActions && (input === 'a' || input === 'A')) {
    return { type: 'open-dialog', dialog: 'failure-actions' }
  }
  if (input === 'q') {
    return ctx.isLive ? { type: 'open-dialog', dialog: 'confirm-quit' } : { type: 'quit' }
  }
  if (input === '?') return { type: 'open-dialog', dialog: 'help' }
  return NONE
}

function resolveScroll(input: string, key: KeyInfo): StepsKeyAction | undefined {
  if (input === 'k') return { type: 'scroll', to: 'up' }
  if (input === 'j') return { type: 'scroll', to: 'down' }
  if (key.pageUp === true) return { type: 'scroll', to: 'page-up' }
  if (key.pageDown === true) return { type: 'scroll', to: 'page-down' }
  if (key.home === true || input === 'g') return { type: 'scroll', to: 'top' }
  if (key.end === true || input === 'G') return { type: 'scroll', to: 'bottom' }
  return undefined
}

// ---------------------------------------------------------------------------
// classifyKey — diagnostic tag for the per-keypress NDJSON key log.
// ---------------------------------------------------------------------------

// Plain single-character keys map straight through; the special-key (key.*)
// checks below run first and take precedence.
const CHAR_KEYS: Record<string, StepsKeyTag> = {
  j: 'j',
  k: 'k',
  f: 'f',
  q: 'q',
  '?': '?',
}

export function classifyKey(input: string, key: KeyInfo): StepsKeyTag {
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
